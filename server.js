// server.js (Final Polish - User List Definitive Fix)
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");
const ytDlpExec = require("yt-dlp-exec");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL = 4000;

let rooms = {};
let userSockets = {};
const searchCache = new Map();
const CACHE_DURATION = 15 * 60 * 1000;

// --- Middleware and Routes (No Changes) ---
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false },
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));
app.use(express.static(path.join(__dirname, "public")));
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect("/");
};
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);
app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect("/");
  });
});
app.get("/api/user", (req, res) => {
  if (req.isAuthenticated()) res.json(req.user);
  else res.status(401).json({ message: "Not authenticated" });
});
app.get("/room/:roomId", ensureAuthenticated, (req, res) => {
  const room = rooms[req.params.roomId];
  if (room) res.sendFile(path.join(__dirname, "views", "room.html"));
  else res.status(404).sendFile(path.join(__dirname, "views", "404.html"));
});
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());
io.use((socket, next) => {
  const user = socket.request.user;
  if (user) {
    socket.user = user;
    next();
  } else {
    next(new Error("unauthorized"));
  }
});

// --- Socket Event Listeners ---
io.on("connection", (socket) => {
  socket.on("getRooms", () =>
    socket.emit("updateRoomsList", getPublicRoomsData())
  );
  socket.on("createRoom", (roomName) => handleCreateRoom(socket, roomName));
  socket.on("joinRoom", (roomId) => handleJoinRoom(socket, roomId));
  socket.on("sendMessage", (msg) => handleSendMessage(socket, msg));
  socket.on("hostPlaybackChange", (data) =>
    handleHostPlaybackChange(socket, data)
  );
  socket.on("disconnect", () => handleLeaveRoom(socket));
  socket.on("addYouTubeTrack", ({ roomId, url }) =>
    handleAddYouTubeTrack(socket, roomId, url)
  );
  socket.on("approveSuggestion", (data) =>
    handleApproveSuggestion(socket, data)
  );
  socket.on("rejectSuggestion", (data) => handleRejectSuggestion(socket, data));
  socket.on("skipTrack", (data) => {
    if (rooms[data.roomId] && socket.user.id === rooms[data.roomId].hostUserId)
      playNextSong(data.roomId);
  });
  socket.on("playPrevTrack", (data) => {
    if (rooms[data.roomId] && socket.user.id === rooms[data.roomId].hostUserId)
      playPrevSong(data.roomId);
  });
  socket.on("playTrackAtIndex", (data) => {
    if (rooms[data.roomId] && socket.user.id === rooms[data.roomId].hostUserId)
      playTrackAtIndex(data.roomId, data.index);
  });
  socket.on("deleteTrack", (data) => handleDeleteTrack(socket, data));
  socket.on("searchYouTube", (data) => handleSearchYouTube(socket, data));
});

// --- Handler Functions ---

// *** THE FIX: Moved this helper function to the top ***
const generateUserList = (room) => {
  if (!room) return [];
  return Object.values(room.listeners).map((listener) => ({
    id: listener.user.id,
    displayName: listener.user.displayName,
    avatar: listener.user.photos[0].value,
    isHost: listener.user.id === room.hostUserId,
  }));
};

const getSanitizedRoomState = (room, isHost, user) => {
  if (!room) return null;
  const userList = generateUserList(room); // Now this function exists
  const {
    songEndTimer,
    deletionTimer,
    syncInterval,
    listeners,
    ...safeRoomState
  } = room;
  safeRoomState.listenerCount = userList.length;
  safeRoomState.isHost = isHost;
  safeRoomState.currentUser = {
    name: user.displayName,
    id: user.id,
    avatar: user.photos[0].value,
  };
  safeRoomState.nowPlaying = getAuthoritativeNowPlaying(room);
  safeRoomState.playlistState = getSanitizedPlaylist(room);
  safeRoomState.suggestions = room.suggestions;
  safeRoomState.isPlaying = room.isPlaying;
  safeRoomState.userList = userList;
  return safeRoomState;
};

function handleJoinRoom(socket, roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.deletionTimer) clearTimeout(room.deletionTimer);
  room.deletionTimer = null;
  socket.join(roomId);
  room.listeners[socket.user.id] = { socketId: socket.id, user: socket.user };
  userSockets[socket.id] = { user: socket.user, roomId };
  const isHost = room.hostUserId === socket.user.id;
  socket.emit("roomState", getSanitizedRoomState(room, isHost, socket.user));
  if (room.nowPlaying) {
    socket.emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  }
  io.to(roomId).emit("newChatMessage", {
    system: true,
    text: `${socket.user.displayName} has joined the vibe.`,
  });
  const userList = generateUserList(room);
  io.to(roomId).emit("updateUserList", userList);
  io.to(roomId).emit("updateListenerCount", userList.length);
  io.emit("updateRoomsList", getPublicRoomsData());
}

function handleLeaveRoom(socket) {
  const userSocketInfo = userSockets[socket.id];
  if (!userSocketInfo) return;
  const { user, roomId } = userSocketInfo;
  const room = rooms[roomId];
  if (room) {
    delete room.listeners[user.id];
    io.to(roomId).emit("newChatMessage", {
      system: true,
      text: `${user.displayName} has left the vibe.`,
    });
    const userList = generateUserList(room);
    io.to(roomId).emit("updateUserList", userList);
    io.to(roomId).emit("updateListenerCount", userList.length);
    if (userList.length === 0) {
      room.deletionTimer = setTimeout(() => {
        if (
          rooms[roomId] &&
          Object.keys(rooms[roomId].listeners).length === 0
        ) {
          if (room.songEndTimer) clearTimeout(room.songEndTimer);
          if (room.syncInterval) clearInterval(room.syncInterval);
          delete rooms[roomId];
          io.emit("updateRoomsList", getPublicRoomsData());
        }
      }, 30 * 1000);
    }
  }
  delete userSockets[socket.id];
  io.emit("updateRoomsList", getPublicRoomsData());
}

// --- All other functions are unchanged below this line ---
async function handleSearchYouTube(socket, { query }) {
  if (!query) return;
  const normalizedQuery = query.trim().toLowerCase();
  if (searchCache.has(normalizedQuery)) {
    const cached = searchCache.get(normalizedQuery);
    if (Date.now() - cached.timestamp < CACHE_DURATION) {
      return socket.emit("searchYouTubeResults", cached.results);
    }
  }
  try {
    const searchResults = await ytDlpExec(`ytsearch5:"${normalizedQuery}"`, {
      dumpSingleJson: true,
      flatPlaylist: true,
    });
    const videoResults = searchResults.entries
      .filter((info) => info)
      .map((info) => ({
        videoId: info.id,
        title: info.title,
        artist: info.uploader || info.channel,
        thumbnail: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      }));
    searchCache.set(normalizedQuery, {
      results: videoResults,
      timestamp: Date.now(),
    });
    socket.emit("searchYouTubeResults", videoResults);
  } catch (error) {
    console.error(`yt-dlp search error for query "${normalizedQuery}":`, error);
    socket.emit("searchYouTubeResults", []);
  }
}
async function handleAddYouTubeTrack(socket, roomId, url) {
  const room = rooms[roomId];
  if (!room) return;
  const isHost = socket.user.id === room.hostUserId;
  const playlistRegex = /[?&]list=([\w-]+)/;
  const playlistMatch = url.match(playlistRegex);
  try {
    let tracksToAdd = [];
    if (playlistMatch) {
      socket.emit("newChatMessage", {
        system: true,
        text: "Processing playlist... this may take a moment.",
      });
      const playlistInfo = await ytDlpExec(url, { dumpSingleJson: true });
      tracksToAdd = playlistInfo.entries
        .filter((info) => info)
        .map((info) => ({
          videoId: info.id,
          name: info.title,
          artist: info.uploader || info.channel,
          albumArt: info.thumbnails?.pop()?.url || "/assets/placeholder.svg",
          duration_ms: info.duration * 1000,
          url: info.url,
          source: "youtube",
        }));
    } else {
      const info = await ytDlpExec(url, {
        dumpSingleJson: true,
        format: "bestaudio/best",
      });
      tracksToAdd.push({
        videoId: info.id,
        name: info.title,
        artist: info.uploader || info.channel,
        albumArt: info.thumbnails?.pop()?.url || "/assets/placeholder.svg",
        duration_ms: info.duration * 1000,
        url: info.url,
        source: "youtube",
      });
    }
    if (isHost) {
      room.playlist.push(...tracksToAdd);
      if (room.nowPlayingIndex === -1 && room.playlist.length > 0) {
        playTrackAtIndex(roomId, 0);
      } else {
        io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
      }
    } else {
      const suggestions = tracksToAdd.map((track) => ({
        ...track,
        suggestionId: `sugg_${Date.now()}_${Math.random()}`,
        suggester: { id: socket.user.id, name: socket.user.displayName },
      }));
      room.suggestions.push(...suggestions);
      io.to(roomId).emit("suggestionsUpdated", room.suggestions);
    }
  } catch (e) {
    console.error("yt-dlp error:", e);
    socket.emit("newChatMessage", {
      system: true,
      text: "Sorry, that link could not be processed.",
    });
  }
}
function handleDeleteTrack(socket, { roomId, indexToDelete }) {
  const room = rooms[roomId];
  if (!room || socket.user.id !== room.hostUserId) return;
  if (indexToDelete < 0 || indexToDelete >= room.playlist.length) return;
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
function handleCreateRoom(socket, roomName) {
  const roomId = `room_${Date.now()}`;
  rooms[roomId] = {
    id: roomId,
    name: roomName,
    hostUserId: socket.user.id,
    listeners: {},
    playlist: [],
    nowPlayingIndex: -1,
    suggestions: [],
    nowPlaying: null,
    songEndTimer: null,
    deletionTimer: null,
    isPlaying: false,
  };
  socket.emit("roomCreated", { roomId });
  io.emit("updateRoomsList", getPublicRoomsData());
}
function playTrackAtIndex(roomId, index) {
  const room = rooms[roomId];
  if (!room) return;
  if (index < 0 || index >= room.playlist.length) {
    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.syncInterval) clearInterval(room.syncInterval);
    room.nowPlaying = null;
    room.isPlaying = false;
    room.nowPlayingIndex = -1;
    io.to(roomId).emit("newSongPlaying", null);
    io.emit("updateRoomsList", getPublicRoomsData());
    return;
  }
  room.nowPlayingIndex = index;
  const track = room.playlist[index];
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  if (room.syncInterval) clearInterval(room.syncInterval);
  room.nowPlaying = { track, startTime: Date.now(), position: 0 };
  room.isPlaying = true;
  io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  io.emit("updateRoomsList", getPublicRoomsData());
  io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
  room.songEndTimer = setTimeout(
    () => playNextSong(roomId),
    track.duration_ms + 1500
  );
  room.syncInterval = setInterval(() => {
    if (room.isPlaying) {
      io.to(roomId).emit("syncPulse", getAuthoritativeNowPlaying(room));
    }
  }, SYNC_INTERVAL);
}
function playNextSong(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const nextIndex = room.nowPlayingIndex + 1;
  playTrackAtIndex(roomId, nextIndex);
}
function playPrevSong(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const prevIndex = room.nowPlayingIndex - 1;
  if (prevIndex >= 0) {
    playTrackAtIndex(roomId, prevIndex);
  }
}
const getAuthoritativeNowPlaying = (room) => {
  if (!room || !room.nowPlaying) return null;
  const authoritativeState = {
    ...room.nowPlaying,
    isPlaying: room.isPlaying,
    serverTimestamp: Date.now(),
    nowPlayingIndex: room.nowPlayingIndex,
  };
  if (room.isPlaying) {
    authoritativeState.position = Date.now() - authoritativeState.startTime;
  }
  return authoritativeState;
};
function handleApproveSuggestion(socket, { roomId, suggestionId }) {
  const room = rooms[roomId];
  if (!room || socket.user.id !== room.hostUserId) return;
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
  if (room.nowPlayingIndex === -1) {
    playTrackAtIndex(roomId, 0);
  } else {
    io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
  }
  io.to(roomId).emit("suggestionsUpdated", room.suggestions);
}
const getSanitizedPlaylist = (room) => ({
  playlist: room.playlist,
  nowPlayingIndex: room.nowPlayingIndex,
});
const getPublicRoomsData = () =>
  Object.values(rooms).map((r) => ({
    id: r.id,
    name: r.name,
    listenerCount: Object.keys(r.listeners).length,
    nowPlaying: r.nowPlaying,
  }));
function handleRejectSuggestion(socket, { roomId, suggestionId }) {
  const room = rooms[roomId];
  if (!room || socket.user.id !== room.hostUserId) return;
  const initialLength = room.suggestions.length;
  room.suggestions = room.suggestions.filter(
    (s) => s.suggestionId !== suggestionId
  );
  if (room.suggestions.length < initialLength) {
    io.to(roomId).emit("suggestionsUpdated", room.suggestions);
  }
}
function handleHostPlaybackChange(socket, data) {
  const room = rooms[data.roomId];
  if (!room || socket.user.id !== room.hostUserId || !room.nowPlaying) return;
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  if (room.syncInterval) clearInterval(room.syncInterval);
  if (data.position !== undefined) {
    room.nowPlaying.position = data.position;
    room.nowPlaying.startTime = Date.now() - data.position;
    room.isPlaying = true;
    const remainingDuration = room.nowPlaying.track.duration_ms - data.position;
    room.songEndTimer = setTimeout(
      () => playNextSong(data.roomId),
      remainingDuration + 1500
    );
  } else {
    room.isPlaying = data.isPlaying;
    if (room.isPlaying) {
      room.nowPlaying.startTime = Date.now() - room.nowPlaying.position;
      const remainingDuration =
        room.nowPlaying.track.duration_ms - room.nowPlaying.position;
      room.songEndTimer = setTimeout(
        () => playNextSong(data.roomId),
        remainingDuration + 1500
      );
    } else {
      room.nowPlaying.position = Date.now() - room.nowPlaying.startTime;
    }
  }
  if (room.isPlaying) {
    room.syncInterval = setInterval(() => {
      if (room.isPlaying) {
        io.to(data.roomId).emit("syncPulse", getAuthoritativeNowPlaying(room));
      }
    }, SYNC_INTERVAL);
  }
  io.to(data.roomId).emit("syncPulse", getAuthoritativeNowPlaying(room));
}
function handleSendMessage(socket, msg) {
  if (!socket.user) return;
  let avatarUrl = socket.user.photos[0].value;
  if (avatarUrl.includes("?sz=")) {
    avatarUrl = avatarUrl.replace(/\?sz=\d+$/, "?sz=128");
  } else if (avatarUrl.includes("=s")) {
    avatarUrl = avatarUrl.replace(/=s\d+.*$/, "=s128-c");
  }
  const message = {
    text: msg.text,
    user: socket.user.displayName,
    userId: socket.user.id,
    avatar: avatarUrl,
  };
  io.to(msg.roomId).emit("newChatMessage", message);
}

server.listen(PORT, () =>
  console.log(`Vibe Rooms server is live on http://localhost:${PORT}`)
);
