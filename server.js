// server.js (Phase 2, Task 2.2 - Definitive Bugfix)
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

// --- Socket Event Listeners (No Changes) ---
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
  socket.on("skipTrack", (data) => {
    if (rooms[data.roomId] && socket.user.id === rooms[data.roomId].hostUserId)
      playNextSong(data.roomId);
  });
  socket.on("disconnect", () => handleLeaveRoom(socket));
  socket.on("addYouTubeTrack", ({ roomId, videoId }) =>
    handleAddYouTubeTrack(socket, roomId, videoId)
  );
  socket.on("approveSuggestion", (data) =>
    handleApproveSuggestion(socket, data)
  );
  socket.on("rejectSuggestion", (data) => handleRejectSuggestion(socket, data));
});

// --- Handler Functions ---

// *** FIX #1: INITIALIZE THE SUGGESTIONS ARRAY ***
function handleCreateRoom(socket, roomName) {
  const roomId = `room_${Date.now()}`;
  rooms[roomId] = {
    id: roomId,
    name: roomName,
    hostUserId: socket.user.id,
    listeners: {},
    queue: [],
    suggestions: [], // THIS LINE WAS MISSING
    nowPlaying: null,
    songEndTimer: null,
    deletionTimer: null,
    isPlaying: false,
  };
  socket.emit("roomCreated", { roomId });
  io.emit("updateRoomsList", getPublicRoomsData());
}

// *** FIX #2: SEND THE SUGGESTIONS ARRAY ON JOIN ***
const getSanitizedRoomState = (room, isHost, user) => {
  if (!room) return null;
  const {
    songEndTimer,
    deletionTimer,
    syncInterval,
    listeners,
    ...safeRoomState
  } = room;
  safeRoomState.listenerCount = Object.keys(listeners).length;
  safeRoomState.isHost = isHost;
  safeRoomState.currentUser = {
    name: user.displayName,
    id: user.id,
    avatar: user.photos[0].value,
  };
  safeRoomState.nowPlaying = getAuthoritativeNowPlaying(room);
  safeRoomState.suggestions = room.suggestions; // THIS LINE WAS MISSING
  safeRoomState.isPlaying = room.isPlaying;
  return safeRoomState;
};

// --- All functions below this line are correct and unchanged ---
async function handleAddYouTubeTrack(socket, roomId, videoId) {
  const room = rooms[roomId];
  if (!room) return;
  const isHost = socket.user.id === room.hostUserId;
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytDlpExec(videoUrl, {
      dumpSingleJson: true,
      format: "bestaudio/best",
    });
    const trackData = {
      videoId: info.id,
      name: info.title,
      artist: info.uploader || info.channel,
      albumArt: info.thumbnails?.pop()?.url || "/assets/placeholder.svg",
      duration_ms: info.duration * 1000,
      url: info.url,
      source: "youtube",
    };
    if (isHost) {
      if (!room.nowPlaying) {
        playTrack(roomId, trackData);
      } else {
        room.queue.push(trackData);
      }
      io.to(roomId).emit("queueUpdated", room.queue);
    } else {
      const suggestion = {
        ...trackData,
        suggestionId: `sugg_${Date.now()}`,
        suggester: { id: socket.user.id, name: socket.user.displayName },
      };
      room.suggestions.push(suggestion);
      io.to(roomId).emit("suggestionsUpdated", room.suggestions);
    }
  } catch (e) {
    console.error("yt-dlp error:", e);
    socket.emit("newChatMessage", {
      system: true,
      text: "Sorry, that YouTube link could not be processed.",
    });
  }
}
function handleApproveSuggestion(socket, { roomId, suggestionId }) {
  const room = rooms[roomId];
  if (!room || socket.user.id !== room.hostUserId) return;
  const suggestionIndex = room.suggestions.findIndex(
    (s) => s.suggestionId === suggestionId
  );
  if (suggestionIndex === -1) return;
  const [approvedSuggestion] = room.suggestions.splice(suggestionIndex, 1);
  const { suggestionId: sid, suggester, ...trackForQueue } = approvedSuggestion;
  if (!room.nowPlaying) {
    playTrack(roomId, trackForQueue);
  } else {
    room.queue.push(trackForQueue);
    io.to(roomId).emit("queueUpdated", room.queue);
  }
  io.to(roomId).emit("suggestionsUpdated", room.suggestions);
}
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
function playTrack(roomId, track) {
  const room = rooms[roomId];
  if (!room || !track) return;
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  if (room.syncInterval) clearInterval(room.syncInterval);
  room.nowPlaying = { track: track, startTime: Date.now(), position: 0 };
  room.isPlaying = true;
  io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  io.emit("updateRoomsList", getPublicRoomsData());
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
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  if (room.syncInterval) clearInterval(room.syncInterval);
  if (room.queue.length === 0) {
    room.nowPlaying = null;
    room.isPlaying = false;
    io.to(roomId).emit("newSongPlaying", null);
    io.emit("updateRoomsList", getPublicRoomsData());
    return;
  }
  const nextTrack = room.queue.shift();
  io.to(roomId).emit("queueUpdated", room.queue);
  playTrack(roomId, nextTrack);
}
const getAuthoritativeNowPlaying = (room) => {
  if (!room || !room.nowPlaying) return null;
  const authoritativeState = {
    ...room.nowPlaying,
    isPlaying: room.isPlaying,
    serverTimestamp: Date.now(),
  };
  if (room.isPlaying) {
    authoritativeState.position = Date.now() - authoritativeState.startTime;
  }
  return authoritativeState;
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
  io.emit("updateRoomsList", getPublicRoomsData());
}
function handleLeaveRoom(socket) {
  const userSocketInfo = userSockets[socket.id];
  if (!userSocketInfo) return;
  const { user, roomId } = userSocketInfo;
  const room = rooms[roomId];
  if (room) {
    delete room.listeners[user.id];
    const listenerCount = Object.keys(room.listeners).length;
    io.to(roomId).emit("newChatMessage", {
      system: true,
      text: `${user.displayName} has left the vibe.`,
    });
    if (listenerCount === 0) {
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
const getPublicRoomsData = () =>
  Object.values(rooms).map((r) => ({
    id: r.id,
    name: r.name,
    listenerCount: Object.keys(r.listeners).length,
    nowPlaying: r.nowPlaying,
  }));

server.listen(PORT, () =>
  console.log(`Vibe Rooms server is live on http://localhost:${PORT}`)
);
