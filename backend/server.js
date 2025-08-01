// server.js
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");
const ytDlpExec = require("yt-dlp-exec");
const cors = require("cors"); // +++ CHANGE: Import cors

const app = express();
const server = http.createServer(app);

// +++ CHANGE START: CORS and Socket.IO configuration for production +++
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://vibe-rooms-five.vercel.app";

const corsOptions = {
  origin: FRONTEND_URL,
  credentials: true, // This allows cookies to be sent from the frontend
};

// Apply CORS middleware to all Express routes
app.use(cors(corsOptions));

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});
// +++ CHANGE END +++

const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL = 4000;

let rooms = {};
let userSockets = {};
const searchCache = new Map();
const CACHE_DURATION = 15 * 60 * 1000;

const RECONNECTION_GRACE_PERIOD = 10 * 1000;
const reconnectionTimers = {};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Middleware and Routes ---
// +++ CHANGE START: Production-ready session middleware +++
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  proxy: true, // Required because Render sits behind a proxy
  cookie: {
    secure: process.env.NODE_ENV === "production", // Set to true in production for HTTPS
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // 'none' for cross-site cookies, 'lax' for local dev
  },
});
// +++ CHANGE END +++

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // The callbackURL should be your backend's URL
      callbackURL: "/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// This part is less critical now as Vercel serves the files, but it's fine for local dev
app.use(express.static(path.join(__dirname, "../frontend")));

const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  // In a real API, you'd send a 401 status. Redirecting is fine here.
  res.redirect(FRONTEND_URL);
};
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: FRONTEND_URL }),
  (req, res) => res.redirect(FRONTEND_URL) // Redirect to the Vercel frontend
);
app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect(FRONTEND_URL); // Redirect to the Vercel frontend
  });
});
app.get("/api/user", (req, res) => {
  if (req.isAuthenticated()) res.json(req.user);
  else res.status(401).json({ message: "Not authenticated" });
});

// These routes will now primarily be hit by Vercel's serverless functions
// or client-side routing, but we keep them for direct access checks.
app.get("/room/:roomId", ensureAuthenticated, (req, res) => {
  const room = rooms[req.params.roomId];
  if (room) {
    // We no longer send a file, we just confirm the room exists.
    // The frontend handles rendering the page.
    res.status(200).json({ message: "Room exists." });
  } else {
    res.status(404).json({ message: "Room not found." });
  }
});

// Catch-all is no longer needed as Vercel handles the frontend routing
// app.get("*", (req, res) => {
//   res.sendFile(path.join(__dirname, "../frontend/views", "index.html"));
// });

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
  socket.on("getRooms", () => {
    broadcastLobbyData();
  });
  socket.on("createRoom", (roomData) => handleCreateRoom(socket, roomData));
  socket.on("joinRoom", (roomId) => handleJoinRoom(socket, roomId));
  socket.on("leaveRoom", ({ roomId }) => {
    processUserLeave(socket, roomId);
  });
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
// (All your handler functions from generateUserList to handleSendMessage remain completely unchanged)
// ...
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
  const userList = generateUserList(room);
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

async function handleJoinRoom(socket, roomId) {
  const room = rooms[roomId];
  if (!room) {
    socket.emit("roomNotFound"); // Let client know room is gone
    return;
  }

  const user = socket.user;
  const isReconnecting = !!reconnectionTimers[user.id];

  if (isReconnecting) {
    console.log(`User ${user.displayName} reconnected within grace period.`);
    clearTimeout(reconnectionTimers[user.id]);
    delete reconnectionTimers[user.id];
  }

  // Revive room if it was about to be deleted
  if (room.deletionTimer) {
    console.log(
      `User ${user.displayName} joined an empty room. Cancelling deletion timer.`
    );
    clearTimeout(room.deletionTimer);
    room.deletionTimer = null;
  }

  socket.join(roomId);
  room.listeners[user.id] = { socketId: socket.id, user: user };
  userSockets[socket.id] = { user: user, roomId };

  // --- Definitive Host Assignment Logic ---
  let isNewHost = false;
  // If the joining user is now the ONLY person in the room, they become the host.
  if (Object.keys(room.listeners).length === 1) {
    if (room.hostUserId !== user.id) {
      room.hostUserId = user.id;
      isNewHost = true;
      await supabase
        .from("rooms")
        .update({ host_user_id: user.id })
        .eq("id", roomId);
      console.log(
        `Assigning ${user.displayName} as the new host of revived room ${roomId}.`
      );
    }
  }

  // Determine final host status *after* potential assignment
  const isHost = room.hostUserId === user.id;

  // Send the initial state to the user *after* all logic is complete
  socket.emit("roomState", getSanitizedRoomState(room, isHost, user));
  if (isNewHost) {
    socket.emit("newChatMessage", {
      system: true,
      text: "👑 You are now the host of this room!",
    });
  }
  if (room.nowPlaying) {
    socket.emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  }

  // Announce join to others and update lists
  if (!isReconnecting) {
    io.to(roomId).emit("newChatMessage", {
      system: true,
      text: `${user.displayName} has joined the vibe.`,
    });
    // The generated user list will now correctly show the new host
    const userList = generateUserList(room);
    io.to(roomId).emit("updateUserList", userList);
    io.to(roomId).emit("updateListenerCount", userList.length);
    broadcastLobbyData();
  } else {
    // On reconnect, just make sure everyone's user list is correct
    io.to(roomId).emit("updateUserList", generateUserList(room));
  }
}

// ... All other handler functions are unchanged ...
// from getLiveVibes to the end of the file

async function getLiveVibes() {
  const { data, error } = await supabase.rpc("get_live_vibe_counts");
  if (error) {
    console.error("Error fetching live vibe counts via RPC:", error);
    return [];
  }
  const vibesWithCounts = data.map((v) => ({
    id: v.id,
    name: v.name,
    type: v.type,
    count: v.room_count,
  }));
  return vibesWithCounts.sort((a, b) => b.count - a.count);
}

async function broadcastLobbyData() {
  const [roomsData, vibes] = await Promise.all([
    getPublicRoomsData(),
    getLiveVibes(),
  ]);
  io.emit("updateLobby", { rooms: roomsData, vibes });
}

async function processUserLeave(socket, roomId) {
  const room = rooms[roomId];
  if (!room || !socket.user || !room.listeners[socket.user.id]) {
    return;
  }

  const user = socket.user;
  console.log(`Processing leave for ${user.displayName} from room ${roomId}`);

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
    console.log(
      `Host migrated in DB for room ${roomId} to ${newHost.user.displayName}`
    );

    const newHostSocket = io.sockets.sockets.get(newHost.socketId);
    if (newHostSocket) {
      newHostSocket.emit("hostAssigned");
      newHostSocket.emit("newChatMessage", {
        system: true,
        text: "👑 You are now the host of this room!",
      });
      newHostSocket.broadcast.to(roomId).emit("newChatMessage", {
        system: true,
        text: `👑 ${newHost.user.displayName} is now the host.`,
      });
    }
  }

  const updatedUserList = generateUserList(room);
  io.to(roomId).emit("updateUserList", updatedUserList);
  io.to(roomId).emit("updateListenerCount", updatedUserList.length);

  if (remainingListeners.length === 0) {
    console.log(`Room ${roomId} is empty. Setting 30-second deletion timer.`);
    room.deletionTimer = setTimeout(async () => {
      if (rooms[roomId] && Object.keys(rooms[roomId].listeners).length === 0) {
        console.log(
          `Room ${roomId} deletion timer fired. Deleting from DB and memory.`
        );
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

function handleLeaveRoom(socket) {
  const userSocketInfo = userSockets[socket.id];
  if (!userSocketInfo) return;

  const { user, roomId } = userSocketInfo;
  console.log(
    `User ${user.displayName} disconnected. Starting grace period timer for room ${roomId}.`
  );

  reconnectionTimers[user.id] = setTimeout(() => {
    console.log(
      `Grace period expired for ${user.displayName}. Processing leave.`
    );
    processUserLeave(socket, roomId);
    delete reconnectionTimers[user.id];
  }, RECONNECTION_GRACE_PERIOD);
}

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
    const searchResults = await ytDlpExec(`ytsearch10:"${normalizedQuery}"`, {
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
async function findOrCreateVibe(vibeData) {
  // First, try to find the vibe by name.
  let { data: existingVibe, error: findError } = await supabase
    .from("vibes")
    .select("id")
    .eq("name", vibeData.name)
    .single();

  if (findError && findError.code !== "PGRST116") {
    // PGRST116 means 'not found'
    console.error("Error finding vibe:", findError);
    return null;
  }

  // If the vibe exists, return its ID.
  if (existingVibe) {
    return existingVibe.id;
  }

  // If it doesn't exist, it must be a custom one. Let's create it.
  if (vibeData.type === "CUSTOM") {
    let { data: newVibe, error: createError } = await supabase
      .from("vibes")
      .insert({ name: vibeData.name, type: "CUSTOM" })
      .select("id")
      .single();

    if (createError) {
      console.error("Error creating custom vibe:", createError);
      return null;
    }
    return newVibe.id;
  }

  // If it's a preset that wasn't found, something is wrong.
  return null;
}

async function handleCreateRoom(socket, roomData) {
  const { roomName, vibe } = roomData;
  if (!roomName || !vibe || !vibe.name || !vibe.type) {
    return socket.emit("error", { message: "Invalid room data provided." });
  }

  try {
    const vibeId = await findOrCreateVibe(vibe);
    if (!vibeId) {
      return socket.emit("error", { message: "Could not process vibe." });
    }

    const { data: newRoom, error: roomError } = await supabase
      .from("rooms")
      .insert({
        name: roomName,
        host_user_id: socket.user.id,
        vibe_id: vibeId,
      })
      .select("id")
      .single();

    if (roomError) {
      console.error("Error creating room in DB:", roomError);
      return socket.emit("error", { message: "Failed to create room." });
    }

    const roomId = newRoom.id.toString();

    rooms[roomId] = {
      id: roomId,
      name: roomName,
      vibe: vibe,
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

    console.log(
      `Room ${roomId} created in DB and memory by ${socket.user.displayName}`
    );
    socket.emit("roomCreated", { roomId });
    broadcastLobbyData();
  } catch (error) {
    console.error("An unexpected error occurred in handleCreateRoom:", error);
    socket.emit("error", { message: "An internal server error occurred." });
  }
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
    broadcastLobbyData(); // Use the new function
    return;
  }
  room.nowPlayingIndex = index;
  const track = room.playlist[index];
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  if (room.syncInterval) clearInterval(room.syncInterval);
  room.nowPlaying = { track, startTime: Date.now(), position: 0 };
  room.isPlaying = true;
  io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  broadcastLobbyData(); // Use the new function
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
    vibe: r.vibe,
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
