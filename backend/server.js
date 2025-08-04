require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
});
const API_KEY = process.env.YOUTUBE_API_KEY;

const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://vibe-rooms-five.vercel.app";
const corsOptions = { origin: FRONTEND_URL, credentials: true };
app.use(cors(corsOptions));

const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"], credentials: true },
  pingInterval: 10000,
  pingTimeout: 20000,
});

const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL = 500;
let rooms = {};
let userSockets = {};
let guestSockets = {}; // For tracking guests
const RECONNECTION_GRACE_PERIOD = 10 * 1000;
const reconnectionTimers = {};
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const pokemonNames = [
  "Pikachu",
  "Charmander",
  "Squirtle",
  "Bulbasaur",
  "Jigglypuff",
  "Snorlax",
  "Eevee",
  "Mewtwo",
  "Gengar",
  "Psyduck",
  "Magikarp",
  "Ditto",
];

const sessionMiddleware = session({
  store: new pgSession({
    pool: pool,
    tableName: "user_sessions",
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  },
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${
        process.env.RENDER_EXTERNAL_URL || "http://localhost:3000"
      }/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.get(
  "/auth/google",
  (req, res, next) => {
    const redirect = req.query.redirect || "/";
    req.session.redirectUrl = redirect;
    next();
  },
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: FRONTEND_URL,
    session: false,
  }),
  (req, res) => {
    const payload = {
      id: req.user.id,
      displayName: req.user.displayName,
      avatar: req.user.photos[0].value,
    };
    const token = jwt.sign(payload, process.env.SESSION_SECRET, {
      expiresIn: "1d",
    });

    const redirectUrl = req.session.redirectUrl || "/";
    req.session.redirectUrl = null;

    let finalRedirectUrl = new URL(FRONTEND_URL);
    finalRedirectUrl.pathname =
      redirectUrl.startsWith("/") && redirectUrl.length > 1 ? redirectUrl : "/";
    finalRedirectUrl.searchParams.set("token", token);
    res.redirect(finalRedirectUrl.toString());
  }
);

const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);
  jwt.verify(token, process.env.SESSION_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

app.get("/api/user", verifyToken, (req, res) => res.json(req.user));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "Vibes server is healthy" });
});

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    socket.user = null;
    return next();
  }
  jwt.verify(token, process.env.SESSION_SECRET, (err, user) => {
    if (err) {
      socket.user = null;
      return next();
    }
    socket.user = user;
    next();
  });
});

io.on("connection", (socket) => {
  socket.on("getRooms", () => broadcastLobbyData());
  socket.on("createRoom", (roomData) => handleCreateRoom(socket, roomData));
  socket.on("joinRoom", (roomId) => handleJoinRoom(socket, roomId));
  socket.on("leaveRoom", ({ roomId }) => processUserLeave(socket, roomId));
  socket.on("sendMessage", (msg) => handleSendMessage(socket, msg));
  socket.on("hostPlaybackChange", (data) =>
    handleHostPlaybackChange(socket, data)
  );
  socket.on("disconnect", () => handleDisconnect(socket));
  socket.on("addYouTubeTrack", (data) => handleAddYouTubeTrack(socket, data));
  socket.on("approveSuggestion", (data) =>
    handleApproveSuggestion(socket, data)
  );
  socket.on("rejectSuggestion", (data) => handleRejectSuggestion(socket, data));
  socket.on("skipTrack", (data) => {
    if (
      !socket.user ||
      !rooms[data.roomId] ||
      socket.user.id !== rooms[data.roomId].hostUserId
    )
      return;
    handleSongEnd(data.roomId);
  });
  socket.on("playPrevTrack", (data) => {
    if (
      !socket.user ||
      !rooms[data.roomId] ||
      socket.user.id !== rooms[data.roomId].hostUserId
    )
      return;
    playPrevSong(data.roomId);
  });
  socket.on("playTrackAtIndex", (data) => {
    if (
      !socket.user ||
      !rooms[data.roomId] ||
      socket.user.id !== rooms[data.roomId].hostUserId
    )
      return;
    playTrackAtIndex(data.roomId, data.index);
  });
  socket.on("deleteTrack", (data) => handleDeleteTrack(socket, data));
  socket.on("hostUpdateDuration", (data) =>
    handleHostUpdateDuration(socket, data)
  );
  socket.on("requestPerfectSync", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.hostUserId) return;
    const hostListener = Object.values(room.listeners).find(
      (l) => l.user.id === room.hostUserId
    );
    if (hostListener && io.sockets.sockets.get(hostListener.socketId)) {
      io.sockets.sockets
        .get(hostListener.socketId)
        .emit("getHostTimestamp", { requesterId: socket.id });
    }
  });
  socket.on("sendHostTimestamp", ({ requesterId, hostPlayerTime }) => {
    const requesterSocket = io.sockets.sockets.get(requesterId);
    if (requesterSocket) {
      requesterSocket.emit("receivePerfectSync", { hostPlayerTime });
    }
  });
  socket.on("toggleLoopMode", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !socket.user || socket.user.id !== room.hostUserId) return;

    const modes = ["none", "playlist", "song"];
    const currentModeIndex = modes.indexOf(room.loopMode || "none");
    const nextModeIndex = (currentModeIndex + 1) % modes.length;
    room.loopMode = modes[nextModeIndex];

    io.to(roomId).emit("loopModeUpdated", { loopMode: room.loopMode });
    showToastToSocket(
      io.sockets.sockets.get(socket.id),
      `Loop mode set to: ${room.loopMode}`
    );
  });
});

async function handleAddYouTubeTrack(socket, { roomId, url }) {
  const room = rooms[roomId];
  if (!room) return;
  if (!socket.user) {
    return socket.emit("toast", {
      type: "error",
      message: "Please log in to suggest songs.",
    });
  }
  try {
    const playlistId = getPlaylistIdFromUrl(url);
    const videoId = getVideoIdFromUrl(url);
    let tracks = [];
    if (playlistId) {
      tracks = await getPlaylistTracks(playlistId);
    } else if (videoId) {
      tracks = await getVideoDetails([videoId]);
    } else {
      return socket.emit("toast", {
        type: "error",
        message: "Invalid YouTube URL.",
      });
    }
    if (tracks.length === 0) {
      return socket.emit("toast", {
        type: "error",
        message: "Could not find videos.",
      });
    }
    const isHost = socket.user.id === room.hostUserId;
    if (isHost) {
      room.playlist.push(...tracks);
      socket.emit("toast", {
        type: "success",
        message: `Added ${tracks.length} track(s)!`,
      });
      if (room.nowPlayingIndex === -1 && room.playlist.length > 0) {
        const firstNewTrackIndex = room.playlist.length - tracks.length;
        playTrackAtIndex(roomId, firstNewTrackIndex);
      } else {
        io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
      }
    } else {
      const newSuggestions = tracks.map((track) => ({
        ...track,
        suggestionId: `sugg_${Date.now()}_${Math.random()}`,
        suggester: { id: socket.user.id, name: socket.user.displayName },
      }));
      room.suggestions.push(...newSuggestions);
      socket.emit("toast", {
        type: "success",
        message: `Sent ${newSuggestions.length} suggestion(s)!`,
      });
      io.to(roomId).emit("suggestionsUpdated", room.suggestions);
    }
  } catch (error) {
    console.error(
      "YouTube API Error:",
      error.response ? error.response.data.error.message : error.message
    );
    socket.emit("toast", {
      type: "error",
      message: "Failed to fetch video data.",
    });
  }
}

function getPlaylistIdFromUrl(url) {
  const match = url.match(/[&?]list=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function getVideoIdFromUrl(url) {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function getPlaylistTracks(playlistId) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${API_KEY}`;
  const response = await axios.get(url);
  const videoIds = response.data.items.map(
    (item) => item.snippet.resourceId.videoId
  );
  return getVideoDetails(videoIds);
}

async function getVideoDetails(videoIds) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(
    ","
  )}&key=${API_KEY}`;
  const response = await axios.get(url);
  return response.data.items.map((item) => ({
    videoId: item.id,
    name: item.snippet.title,
    artist: item.snippet.channelTitle,
    albumArt:
      item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default.url,
    duration_ms: parseISO8601Duration(item.contentDetails.duration),
    url: `https://www.youtube.com/watch?v=${item.id}`,
    source: "youtube",
  }));
}

function parseISO8601Duration(isoDuration) {
  const regex =
    /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
  const matches = isoDuration.match(regex);
  const seconds = parseFloat(matches[7] || 0);
  const minutes = parseInt(matches[6] || 0);
  const hours = parseInt(matches[5] || 0);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function handleHostUpdateDuration(socket, { roomId, trackIndex, durationMs }) {
  const room = rooms[roomId];
  if (
    !socket.user ||
    !room ||
    socket.user.id !== room.hostUserId ||
    room.nowPlayingIndex !== trackIndex ||
    !room.playlist[trackIndex]
  )
    return;
  const track = room.playlist[trackIndex];
  if (track.duration_ms === durationMs) return;
  track.duration_ms = durationMs;
  if (room.nowPlaying && room.nowPlaying.track.videoId === track.videoId) {
    room.nowPlaying.track.duration_ms = durationMs;
  }
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  const timeSincePlay = Date.now() - room.nowPlaying.startTime;
  const remainingDuration = durationMs - timeSincePlay;
  room.songEndTimer = setTimeout(
    () => handleSongEnd(roomId),
    remainingDuration + 500
  );
  io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
}

const generateUserList = (room) => {
  if (!room || !room.listeners) return [];
  return Object.values(room.listeners).map((listener) => ({
    id: listener.user.id,
    displayName: listener.user.displayName,
    avatar: listener.user.avatar,
    isHost: listener.user.id === room.hostUserId,
  }));
};

const generateGuestList = (room) => {
  if (!room || !room.guests) return [];
  return Object.values(room.guests);
};

const getSanitizedPlaylist = (room) => ({
  playlist: room.playlist,
  nowPlayingIndex: room.nowPlayingIndex,
  isPlaying: room.isPlaying,
});

async function handleJoinRoom(socket, slug) {
  let room = Object.values(rooms).find((r) => r.slug === slug);
  if (!room) {
    const { data: dbRoom, error } = await supabase
      .from("rooms")
      .select("*, vibe_id(name, type)")
      .eq("slug", slug)
      .single();
    if (error || !dbRoom) return socket.emit("roomNotFound");
    const roomId = dbRoom.id.toString();
    rooms[roomId] = {
      id: roomId,
      slug: dbRoom.slug,
      name: dbRoom.name,
      vibe: { name: dbRoom.vibe_id.name, type: dbRoom.vibe_id.type },
      hostUserId: dbRoom.host_user_id,
      listeners: {},
      guests: {},
      playlist: [],
      nowPlayingIndex: -1,
      suggestions: [],
      nowPlaying: null,
      songEndTimer: null,
      deletionTimer: null,
      isPlaying: false,
      loopMode: "none",
    };
    room = rooms[roomId];
  }

  const roomId = room.id;
  const user = socket.user;

  socket.join(roomId);

  if (room.deletionTimer) {
    clearTimeout(room.deletionTimer);
    room.deletionTimer = null;
  }

  let isHost = false;
  let finalUser = null;

  if (user) {
    isHost = room.hostUserId === user.id;
    finalUser = {
      id: user.id,
      displayName: user.displayName,
      avatar: user.avatar,
    };
    if (reconnectionTimers[user.id]) {
      clearTimeout(reconnectionTimers[user.id]);
      delete reconnectionTimers[user.id];
    }
    room.listeners[user.id] = { socketId: socket.id, user: user };
    userSockets[socket.id] = { user: user, roomId };

    if (Object.keys(room.listeners).length === 1 && !room.hostUserId) {
      room.hostUserId = user.id;
      await supabase
        .from("rooms")
        .update({ host_user_id: user.id })
        .eq("id", roomId);
      isHost = true;
    }
    io.to(roomId).emit("newChatMessage", {
      system: true,
      text: `${user.displayName} has joined the vibe.`,
    });
  } else {
    // This is a guest
    const guestName =
      pokemonNames[Math.floor(Math.random() * pokemonNames.length)];
    const guestUser = { id: socket.id, displayName: guestName, isGuest: true };
    room.guests[socket.id] = guestUser;
    guestSockets[socket.id] = { roomId };
    io.to(roomId).emit("newChatMessage", {
      system: true,
      text: `${guestName} (Guest) has joined the vibe.`,
    });
  }

  const userList = generateUserList(room);
  const guestList = generateGuestList(room);
  const listenerCount = io.sockets.adapter.rooms.get(roomId)?.size || 1;

  socket.emit(
    "roomState",
    getSanitizedRoomState(
      room,
      isHost,
      finalUser,
      listenerCount,
      userList,
      guestList
    )
  );

  broadcastRoomUpdates(roomId);
  broadcastLobbyData();
}

function broadcastRoomUpdates(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const userList = generateUserList(room);
  const guestList = generateGuestList(room);
  const listenerCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;

  io.to(roomId).emit("rosterUpdated", {
    userList: userList,
    guestList: guestList,
  });
  io.to(roomId).emit("updateListenerCount", listenerCount);
}

async function processUserLeave(socket, roomId) {
  const room = rooms[roomId];
  if (!room || !socket.user || !room.listeners[socket.user.id]) return;

  const user = socket.user;
  const wasHost = room.hostUserId === user.id;
  delete room.listeners[user.id];
  delete userSockets[socket.id];

  io.to(roomId).emit("newChatMessage", {
    system: true,
    text: `${user.displayName} has left the vibe.`,
  });

  const remainingListeners = Object.values(room.listeners);
  if (wasHost && remainingListeners.length > 0) {
    const newHost = remainingListeners[0];
    room.hostUserId = newHost.user.id;
    await supabase
      .from("rooms")
      .update({ host_user_id: newHost.user.id })
      .eq("id", roomId);
    const newHostSocket = io.sockets.sockets.get(newHost.socketId);
    if (newHostSocket) {
      newHostSocket.emit("hostAssigned");
      io.to(roomId).emit("newChatMessage", {
        system: true,
        text: `👑 ${newHost.user.displayName} is now the host.`,
      });
    }
  }

  broadcastRoomUpdates(roomId);

  if (
    Object.keys(room.listeners).length === 0 &&
    Object.keys(room.guests).length === 0
  ) {
    room.deletionTimer = setTimeout(async () => {
      if (
        rooms[roomId] &&
        Object.keys(rooms[roomId].listeners).length === 0 &&
        Object.keys(rooms[roomId].guests).length === 0
      ) {
        if (room.songEndTimer) clearTimeout(room.songEndTimer);
        if (room.syncInterval) clearInterval(room.syncInterval);
        delete rooms[roomId];
        await supabase.from("rooms").delete().eq("id", roomId);
        broadcastLobbyData();
      }
    }, 30 * 1000);
  }
  broadcastLobbyData();
}

function handleDisconnect(socket) {
  const userSocketInfo = userSockets[socket.id];
  if (userSocketInfo) {
    reconnectionTimers[userSocketInfo.user.id] = setTimeout(() => {
      processUserLeave(socket, userSocketInfo.roomId);
      delete reconnectionTimers[userSocketInfo.user.id];
    }, RECONNECTION_GRACE_PERIOD);
    return;
  }

  const guestSocketInfo = guestSockets[socket.id];
  if (guestSocketInfo) {
    const { roomId } = guestSocketInfo;
    const room = rooms[roomId];
    if (room && room.guests[socket.id]) {
      io.to(roomId).emit("newChatMessage", {
        system: true,
        text: `${
          room.guests[socket.id].displayName
        } (Guest) has left the vibe.`,
      });
      delete room.guests[socket.id];
      delete guestSockets[socket.id];
      broadcastRoomUpdates(roomId);
      broadcastLobbyData();
    }
  }
}

function playTrackAtIndex(roomId, index) {
  const room = rooms[roomId];
  if (!room) return;
  if (index < 0 || index >= room.playlist.length) {
    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.syncInterval) {
      clearInterval(room.syncInterval);
      room.syncInterval = null;
    }
    room.nowPlaying = null;
    room.isPlaying = false;
    room.nowPlayingIndex = -1;
    io.to(roomId).emit("newSongPlaying", null);
    broadcastLobbyData();
    return;
  }
  room.nowPlayingIndex = index;
  const track = room.playlist[index];
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  room.nowPlaying = { track, startTime: Date.now(), position: 0 };
  room.isPlaying = true;
  if (!room.syncInterval) {
    room.syncInterval = setInterval(() => {
      if (rooms[roomId]) {
        io.to(roomId).emit(
          "syncPulse",
          getAuthoritativeNowPlaying(rooms[roomId])
        );
      }
    }, SYNC_INTERVAL);
  }
  room.songEndTimer = setTimeout(
    () => handleSongEnd(roomId),
    track.duration_ms + 1500
  );
  io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  broadcastLobbyData();
  io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
}

const getAuthoritativeNowPlaying = (room) => {
  if (!room || !room.nowPlaying) return null;

  const currentPosition = room.isPlaying
    ? Date.now() - room.nowPlaying.startTime
    : room.nowPlaying.position;

  return {
    track: room.nowPlaying.track,
    startTime: room.nowPlaying.startTime,
    position: currentPosition,
    isPlaying: room.isPlaying,
    serverTimestamp: Date.now(),
    nowPlayingIndex: room.nowPlayingIndex,
  };
};

const getSanitizedRoomState = (
  room,
  isHost,
  currentUser,
  listenerCount,
  userList,
  guestList
) => {
  if (!room) return null;
  const {
    songEndTimer,
    deletionTimer,
    syncInterval,
    listeners,
    guests,
    ...safeRoomState
  } = room;

  safeRoomState.listenerCount = listenerCount;
  safeRoomState.isHost = isHost;
  safeRoomState.currentUser = currentUser;
  safeRoomState.nowPlaying = getAuthoritativeNowPlaying(room);
  safeRoomState.playlistState = getSanitizedPlaylist(room);
  safeRoomState.suggestions = room.suggestions;
  safeRoomState.userList = userList;
  safeRoomState.guestList = guestList;
  safeRoomState.chatHistory = room.chatHistory || [];
  safeRoomState.loopMode = room.loopMode;
  return safeRoomState;
};

function handleHostPlaybackChange(socket, data) {
  const room = rooms[data.roomId];
  if (
    !socket.user ||
    !room ||
    socket.user.id !== room.hostUserId ||
    !room.nowPlaying
  )
    return;

  if (room.songEndTimer) clearTimeout(room.songEndTimer);

  const positionBeforeChange = room.isPlaying
    ? Date.now() - room.nowPlaying.startTime
    : room.nowPlaying.position;

  room.isPlaying = data.isPlaying;
  room.nowPlaying.position =
    data.position !== undefined ? data.position : positionBeforeChange;
  room.nowPlaying.startTime = Date.now() - room.nowPlaying.position;

  if (room.isPlaying) {
    const remainingDuration =
      room.nowPlaying.track.duration_ms - room.nowPlaying.position;
    room.songEndTimer = setTimeout(
      () => handleSongEnd(data.roomId),
      remainingDuration + 1500
    );
  }

  io.to(data.roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  broadcastLobbyData();
}

function handleSendMessage(socket, msg) {
  const room = rooms[msg.roomId];
  if (!socket.user || !room) return;
  const message = {
    messageId: `msg_${Date.now()}_${Math.random()}`,
    text: msg.text,
    user: socket.user.displayName,
    userId: socket.user.id,
    avatar: socket.user.avatar,
  };
  if (!room.chatHistory) room.chatHistory = [];
  room.chatHistory.push(message);

  if (room.chatHistory.length > 100) {
    room.chatHistory.shift();
  }

  io.to(msg.roomId).emit("newChatMessage", message);
}

async function broadcastLobbyData() {
  const [roomsData, vibes] = await Promise.all([
    getPublicRoomsData(),
    getLiveVibes(),
  ]);
  io.emit("updateLobby", { rooms: roomsData, vibes });
}

const getPublicRoomsData = () =>
  Object.values(rooms).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    listenerCount: io.sockets.adapter.rooms.get(r.id)?.size || 1,
    nowPlaying: r.nowPlaying,
    vibe: r.vibe,
  }));

async function getLiveVibes() {
  const { data, error } = await supabase.rpc("get_live_vibe_counts");
  if (error) {
    console.error("Error fetching live vibe counts:", error);
    return [];
  }
  return data
    .map((v) => ({ id: v.id, name: v.name, type: v.type, count: v.room_count }))
    .sort((a, b) => b.count - a.count);
}

function playNextSong(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  playTrackAtIndex(roomId, room.nowPlayingIndex + 1);
}

function handleSongEnd(roomId) {
  const room = rooms[roomId];
  if (!room || !room.playlist || room.playlist.length === 0) return;

  switch (room.loopMode) {
    case "song":
      playTrackAtIndex(roomId, room.nowPlayingIndex);
      break;
    case "playlist":
      const nextIndex = (room.nowPlayingIndex + 1) % room.playlist.length;
      playTrackAtIndex(roomId, nextIndex);
      break;
    default:
      playNextSong(roomId);
      break;
  }
}

function playPrevSong(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.nowPlayingIndex - 1 >= 0) {
    playTrackAtIndex(roomId, room.nowPlayingIndex - 1);
  }
}

function handleDeleteTrack(socket, { roomId, indexToDelete }) {
  const room = rooms[roomId];
  if (
    !socket.user ||
    !room ||
    socket.user.id !== room.hostUserId ||
    indexToDelete < 0 ||
    indexToDelete >= room.playlist.length
  )
    return;
  const isDeletingCurrent = room.nowPlayingIndex === indexToDelete;
  room.playlist.splice(indexToDelete, 1);
  if (indexToDelete < room.nowPlayingIndex) {
    room.nowPlayingIndex--;
  }
  if (isDeletingCurrent) {
    playTrackAtIndex(roomId, room.nowPlayingIndex);
  } else {
    io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
  }
}

function handleApproveSuggestion(socket, { roomId, suggestionId }) {
  const room = rooms[roomId];
  if (!socket.user || !room || socket.user.id !== room.hostUserId) return;
  const suggestionIndex = room.suggestions.findIndex(
    (s) => s.suggestionId === suggestionId
  );
  if (suggestionIndex === -1) return;
  const [approvedSuggestion] = room.suggestions.splice(suggestionIndex, 1);
  const {
    suggestionId: sid,
    suggester,
    ...trackForPlaylist
  } = approvedSuggestion;
  room.playlist.push(trackForPlaylist);
  io.to(roomId).emit("suggestionsUpdated", room.suggestions);
  if (room.nowPlayingIndex === -1) {
    playTrackAtIndex(roomId, room.playlist.length - 1);
  } else {
    io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
  }
}

function handleRejectSuggestion(socket, { roomId, suggestionId }) {
  const room = rooms[roomId];
  if (!socket.user || !room || socket.user.id !== room.hostUserId) return;
  const initialLength = room.suggestions.length;
  room.suggestions = room.suggestions.filter(
    (s) => s.suggestionId !== suggestionId
  );
  if (room.suggestions.length < initialLength) {
    io.to(roomId).emit("suggestionsUpdated", room.suggestions);
  }
}

async function findOrCreateVibe(vibeData) {
  let { data: existingVibe } = await supabase
    .from("vibes")
    .select("id")
    .eq("name", vibeData.name)
    .single();
  if (existingVibe) return existingVibe.id;
  if (vibeData.type === "CUSTOM") {
    let { data: newVibe } = await supabase
      .from("vibes")
      .insert({ name: vibeData.name, type: "CUSTOM" })
      .select("id")
      .single();
    return newVibe ? newVibe.id : null;
  }
  return null;
}

async function handleCreateRoom(socket, roomData) {
  if (!socket.user) {
    return socket.emit("error", {
      message: "You must be logged in to create a room.",
    });
  }
  const { roomName, vibe } = roomData;
  if (!roomName || !vibe)
    return socket.emit("error", { message: "Invalid room data." });
  try {
    const vibeId = await findOrCreateVibe(vibe);
    if (!vibeId)
      return socket.emit("error", { message: "Could not process vibe." });
    const slug = generateSlug(roomName);
    const { data: newRoom, error } = await supabase
      .from("rooms")
      .insert({
        name: roomName,
        host_user_id: socket.user.id,
        vibe_id: vibeId,
        slug: slug,
      })
      .select("id, slug")
      .single();
    if (error)
      return socket.emit("error", { message: "Failed to create room." });
    const roomId = newRoom.id.toString();
    rooms[roomId] = {
      id: roomId,
      slug: newRoom.slug,
      name: roomName,
      vibe: vibe,
      hostUserId: socket.user.id,
      listeners: {},
      guests: {},
      playlist: [],
      nowPlayingIndex: -1,
      suggestions: [],
      nowPlaying: null,
      songEndTimer: null,
      deletionTimer: null,
      isPlaying: false,
      loopMode: "none",
    };
    socket.emit("roomCreated", { slug: newRoom.slug });
    broadcastLobbyData();
  } catch (error) {
    socket.emit("error", { message: "An internal server error occurred." });
  }
}

const generateSlug = (name) => {
  const baseSlug = name
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^\w-]+/g, "");
  const randomString = Math.random().toString(36).substring(2, 8);
  return `${baseSlug}-${randomString}`;
};

function showToastToSocket(socket, message, type = "success") {
  if (socket) {
    socket.emit("toast", { type, message });
  }
}

server.listen(PORT, () =>
  console.log(`VIBES server is live on http://localhost:${PORT}`)
);
