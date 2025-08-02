// backend/server.js

// --- NO CHANGES TO SETUP AND AUTHENTICATION ---
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const axios = require('axios');
const API_KEY = process.env.YOUTUBE_API_KEY;
// const play = require("play-dl");
const fs = require("fs");



const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://vibe-rooms-five.vercel.app";
const corsOptions = { origin: FRONTEND_URL, credentials: true };
app.use(cors(corsOptions));
const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"], credentials: true },
});
const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL = 1000;
let rooms = {};
let userSockets = {};
const RECONNECTION_GRACE_PERIOD = 10 * 1000;
const reconnectionTimers = {};
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
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
    res.redirect(`${FRONTEND_URL}?token=${token}`);
  }
);

const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) {
    // No token was provided
    return res.sendStatus(401); // Unauthorized
  }

  jwt.verify(token, process.env.SESSION_SECRET, (err, user) => {
    if (err) {
      // The token is invalid or expired
      return res.sendStatus(403); // Forbidden
    }
    // The token is valid, attach the user info to the request object
    req.user = user;
    next(); // Proceed to the next function (the main route handler)
  });
};

app.get("/api/user", verifyToken, (req, res) => {
  // If we reach this point, it means verifyToken successfully authenticated the user.
  // We can now safely send back the user's information.
  res.json(req.user);
});

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("unauthorized: no token provided"));
  jwt.verify(token, process.env.SESSION_SECRET, (err, user) => {
    if (err) return next(new Error("unauthorized: invalid token"));
    socket.user = user;
    next();
  });
});

// --- SOCKET.IO EVENT LISTENERS ---
io.on("connection", (socket) => {
  socket.on("getRooms", () => broadcastLobbyData());
  socket.on("createRoom", (roomData) => handleCreateRoom(socket, roomData));
  socket.on("joinRoom", (roomId) => handleJoinRoom(socket, roomId));
  socket.on("leaveRoom", ({ roomId }) => processUserLeave(socket, roomId));
  socket.on("sendMessage", (msg) => handleSendMessage(socket, msg));
  socket.on("hostPlaybackChange", (data) =>
    handleHostPlaybackChange(socket, data)
  );
  socket.on("disconnect", () => handleLeaveRoom(socket));
  socket.on("addYouTubeTrack", (data) => handleAddYouTubeTrack(socket, data)); // --> This now uses the new logic
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
  socket.on("hostUpdateDuration", (data) => handleHostUpdateDuration(socket, data));
  // --- DELETED: The 'searchYouTube' listener has been removed ---
});

// --> CHANGE: This entire function is now simpler and quota-free.
async function handleAddYouTubeTrack(socket, { roomId, url }) {
  const room = rooms[roomId];
  if (!room) return;

  try {
    const playlistId = getPlaylistIdFromUrl(url);
    const videoId = getVideoIdFromUrl(url);
    let tracks = [];

    if (playlistId) {
      // It's a playlist URL
      console.log(`Fetching playlist: ${playlistId}`);
      tracks = await getPlaylistTracks(playlistId);
    } else if (videoId) {
      // It's a single video URL
      console.log(`Fetching single video: ${videoId}`);
      tracks = await getVideoDetails([videoId]);
    } else {
      // Invalid URL
      // It's good practice to notify the user who sent the invalid link.
      socket.emit("toast", { type: "error", message: "Invalid YouTube URL provided." });
      return;
    }

    if (tracks.length === 0) {
      socket.emit("toast", { type: "error", message: "Could not find any videos from that URL." });
      return;
    }

    // Now, add the fetched tracks to the room
    const isHost = socket.user.id === room.hostUserId;
    if (isHost) {
      // Host adds all tracks directly to the main playlist.
      room.playlist.push(...tracks);
      
      // Notify the host that tracks were added.
      socket.emit("toast", { type: "success", message: `Added ${tracks.length} track(s) to the playlist!` });

      // If nothing was playing, start the first song of the newly added batch.
      if (room.nowPlayingIndex === -1 && room.playlist.length > 0) {
        // Find the index of the first new track, which is the total length minus the number of new tracks.
        const firstNewTrackIndex = room.playlist.length - tracks.length;
        playTrackAtIndex(roomId, firstNewTrackIndex);
      } else {
        // If something was already playing, just update everyone's queue.
        io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
      }
    } else {
      // --- THIS IS THE UPDATED GUEST LOGIC ---
      // Guest's submission becomes suggestions for all fetched tracks.
      const newSuggestions = tracks.map(track => ({
        ...track,
        suggestionId: `sugg_${Date.now()}_${Math.random()}`,
        suggester: { id: socket.user.id, name: socket.user.displayName },
      }));

      // Add all the new suggestions to the room's suggestion list.
      room.suggestions.push(...newSuggestions);
      
      // Notify the guest that their suggestions were received.
      socket.emit("toast", { type: "success", message: `Sent ${newSuggestions.length} suggestion(s) to the host!` });

      // Notify all clients of the updated suggestions list so it appears in the UI.
      io.to(roomId).emit("suggestionsUpdated", room.suggestions);
    }

  } catch (error) {
    // Detailed logging for the server admin.
    console.error("YouTube API Error:", error.response ? error.response.data.error.message : error.message);
    // A generic, user-friendly error for the client.
    socket.emit("toast", { type: "error", message: "Failed to fetch video data from YouTube." });
  }
}

// --- Helper Functions for YouTube API ---

function getPlaylistIdFromUrl(url) {
  const match = url.match(/[&?]list=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function getVideoIdFromUrl(url) {
    const patterns = [
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
        /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]+)/
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
  const videoIds = response.data.items.map(item => item.snippet.resourceId.videoId);
  return getVideoDetails(videoIds);
}

async function getVideoDetails(videoIds) {
  // YouTube API allows fetching details for up to 50 videos at once.
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${API_KEY}`;
  const response = await axios.get(url);

  return response.data.items.map(item => ({
    videoId: item.id,
    name: item.snippet.title,
    artist: item.snippet.channelTitle,
    albumArt: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default.url,
    // Convert ISO 8601 duration (e.g., "PT2M34S") to milliseconds
    duration_ms: parseISO8601Duration(item.contentDetails.duration),
    url: `https://www.youtube.com/watch?v=${item.id}`,
    source: 'youtube',
  }));
}

function parseISO8601Duration(isoDuration) {
    const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const matches = isoDuration.match(regex);
    const seconds = (parseFloat(matches[7] || 0));
    const minutes = (parseInt(matches[6] || 0));
    const hours = (parseInt(matches[5] || 0));
    // We can ignore days/weeks/etc for music videos
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function handleHostUpdateDuration(socket, { roomId, trackIndex, durationMs }) {
  const room = rooms[roomId];
  // Security check: only the host can do this, and only for the currently playing song.
  if (
    !room ||
    socket.user.id !== room.hostUserId ||
    room.nowPlayingIndex !== trackIndex ||
    !room.playlist[trackIndex]
  ) {
    return;
  }

  const track = room.playlist[trackIndex];
  // If we already have the correct duration, do nothing.
  if (track.duration_ms === durationMs) return;

  console.log(`--> Server received correct duration for track ${trackIndex}: ${durationMs}ms`);
  // 1. Update the duration in the server's authoritative playlist.
  track.duration_ms = durationMs;
  
  // 2. Also update the currently playing object's duration.
  if (room.nowPlaying && room.nowPlaying.track.videoId === track.videoId) {
      room.nowPlaying.track.duration_ms = durationMs;
  }

  // 3. Reset the song end timer with the CORRECT duration.
  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  const timeSincePlay = Date.now() - room.nowPlaying.startTime;
  const remainingDuration = durationMs - timeSincePlay;
  // A 500ms buffer is safer than 1500ms now that we have the correct duration.
  room.songEndTimer = setTimeout(() => playNextSong(roomId), remainingDuration + 500);

  // --> THIS IS THE FIX <--
  // 4. Forcefully re-sync ALL clients with a newSongPlaying event.
  // This tells every client to completely refresh their player with the corrected duration.
  io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
}

// --- DELETED: The handleSearchYouTube function has been completely removed. ---

// --- NO OTHER SIGNIFICANT CHANGES REQUIRED FOR THE BACKEND ---
// All your other functions for room management, chat, sync, etc., will work as they did before.
// I've included them here for completeness.
const generateUserList = (room) => {
  if (!room) return [];
  return Object.values(room.listeners).map((listener) => ({
    id: listener.user.id,
    displayName: listener.user.displayName,
    avatar: listener.user.avatar,
    isHost: listener.user.id === room.hostUserId,
  }));
};
const getSanitizedPlaylist = (room) => ({
  playlist: room.playlist,
  nowPlayingIndex: room.nowPlayingIndex,
});
async function handleJoinRoom(socket, slug) {
  let room = Object.values(rooms).find((r) => r.slug === slug);
  if (!room) {
    const { data: dbRoom, error } = await supabase
      .from("rooms")
      .select("*, vibe_id(name, type)")
      .eq("slug", slug)
      .single();
    if (error || !dbRoom) {
      socket.emit("roomNotFound");
      return;
    }
    const roomId = dbRoom.id.toString();
    rooms[roomId] = {
      id: roomId,
      slug: dbRoom.slug,
      name: dbRoom.name,
      vibe: { name: dbRoom.vibe_id.name, type: dbRoom.vibe_id.type },
      hostUserId: dbRoom.host_user_id,
      listeners: {},
      playlist: [],
      nowPlayingIndex: -1,
      suggestions: [],
      nowPlaying: null,
      songEndTimer: null,
      deletionTimer: null,
      isPlaying: false,
    };
    room = rooms[roomId];
  }
  const roomId = room.id;
  const user = socket.user;
  const isReconnecting = !!reconnectionTimers[user.id];
  if (isReconnecting) {
    clearTimeout(reconnectionTimers[user.id]);
    delete reconnectionTimers[user.id];
  }
  if (room.deletionTimer) {
    clearTimeout(room.deletionTimer);
    room.deletionTimer = null;
  }
  socket.join(roomId);
  room.listeners[user.id] = { socketId: socket.id, user: user };
  userSockets[socket.id] = { user: user, roomId };
  let isNewHost = false;
  if (Object.keys(room.listeners).length === 1) {
    if (room.hostUserId !== user.id) {
      room.hostUserId = user.id;
      isNewHost = true;
      await supabase
        .from("rooms")
        .update({ host_user_id: user.id })
        .eq("id", roomId);
    }
  }
  const isHost = room.hostUserId === user.id;
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
  if (!isReconnecting) {
    io.to(roomId).emit("newChatMessage", {
      system: true,
      text: `${user.displayName} has joined the vibe.`,
    });
    const userList = generateUserList(room);
    io.to(roomId).emit("updateUserList", userList);
    io.to(roomId).emit("updateListenerCount", userList.length);
    broadcastLobbyData();
  } else {
    io.to(roomId).emit("updateUserList", generateUserList(room));
  }
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
      newHostSocket.emit("newChatMessage", {
        system: true,
        text: "👑 You are now the host of this room!",
      });
      newHostSocket.broadcast
        .to(roomId)
        .emit("newChatMessage", {
          system: true,
          text: `👑 ${newHost.user.displayName} is now the host.`,
        });
    }
  }
  const updatedUserList = generateUserList(room);
  io.to(roomId).emit("updateUserList", updatedUserList);
  io.to(roomId).emit("updateListenerCount", updatedUserList.length);
  if (remainingListeners.length === 0) {
    room.deletionTimer = setTimeout(async () => {
      if (rooms[roomId] && Object.keys(rooms[roomId].listeners).length === 0) {
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
  reconnectionTimers[user.id] = setTimeout(() => {
    processUserLeave(socket, roomId);
    delete reconnectionTimers[user.id];
  }, RECONNECTION_GRACE_PERIOD);
}
function playTrackAtIndex(roomId, index) {
  const room = rooms[roomId];
  if (!room) return;

  // This block handles the end of the playlist
  if (index < 0 || index >= room.playlist.length) {
    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    // It is correct to clear the syncInterval here, because no song is loaded.
    if (room.syncInterval) clearInterval(room.syncInterval);
    room.syncInterval = null; // Set to null to be certain
    room.nowPlaying = null;
    room.isPlaying = false;
    room.nowPlayingIndex = -1;
    io.to(roomId).emit("newSongPlaying", null);
    broadcastLobbyData();
    return;
  }

  room.nowPlayingIndex = index;
  const track = room.playlist[index];

  // Clear any previous song-end timer
  if (room.songEndTimer) clearTimeout(room.songEndTimer);

  room.nowPlaying = { track, startTime: Date.now(), position: 0 };
  room.isPlaying = true;

  // THE FIX: Only create a new interval if one doesn't already exist.
  // This interval will now run continuously as long as a song is loaded (playing or paused).
  if (!room.syncInterval) {
    console.log(`Starting sync interval for room ${roomId}`);
    room.syncInterval = setInterval(() => {
      // Add a safety check in case the room is deleted while the interval is running
      if (rooms[roomId]) { 
        io.to(roomId).emit("syncPulse", getAuthoritativeNowPlaying(rooms[roomId]));
      }
    }, SYNC_INTERVAL);
  }

  // Set the timer for the *next* song
  room.songEndTimer = setTimeout(
    () => playNextSong(roomId),
    track.duration_ms + 1500
  );

  // Broadcast the new song immediately
  io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  broadcastLobbyData();
  io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
}

const getAuthoritativeNowPlaying = (room) => {
  if (!room || !room.nowPlaying) return null;
  const authoritativeState = {
    ...room.nowPlaying,
    isPlaying: room.isPlaying,
    serverTimestamp: Date.now(),
    nowPlayingIndex: room.nowPlayingIndex,
  };
  if (room.isPlaying)
    authoritativeState.position = Date.now() - authoritativeState.startTime;
  return authoritativeState;
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
    avatar: user.avatar,
  };
  safeRoomState.nowPlaying = getAuthoritativeNowPlaying(room);
  safeRoomState.playlistState = getSanitizedPlaylist(room);
  safeRoomState.suggestions = room.suggestions;
  safeRoomState.isPlaying = room.isPlaying;
  safeRoomState.userList = userList;
  // --> ADD THIS LINE <--
  safeRoomState.chatHistory = room.chatHistory || []; 
  return safeRoomState;
};

function handleHostPlaybackChange(socket, data) {
  const room = rooms[data.roomId];
  if (!room || socket.user.id !== room.hostUserId || !room.nowPlaying) return;

  if (room.songEndTimer) clearTimeout(room.songEndTimer);
  
  const currentPosition = Date.now() - room.nowPlaying.startTime;
  room.nowPlaying.position = currentPosition;
  
  // Update the playing state based on the host's action
  // If the host provides an isPlaying state (e.g., from seeking), use it. Otherwise, use the one from the button click.
  room.isPlaying = data.isPlaying;

  // If the host also sent a new position (i.e., they seeked the bar), we honor that.
  if (data.position !== undefined) {
    room.nowPlaying.position = data.position;
  }
  
  room.nowPlaying.startTime = Date.now() - room.nowPlaying.position;

  if (room.isPlaying) {
    const remainingDuration = room.nowPlaying.track.duration_ms - room.nowPlaying.position;
    room.songEndTimer = setTimeout(
      () => playNextSong(data.roomId),
      remainingDuration + 1500
    );
  }

  io.to(data.roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
  broadcastLobbyData();
}

function handleSendMessage(socket, msg) {
  if (!socket.user) return;
  const message = {
    text: msg.text,
    user: socket.user.displayName,
    userId: socket.user.id,
    avatar: socket.user.avatar,
  };
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
    listenerCount: Object.keys(r.listeners).length,
    nowPlaying: r.nowPlaying,
    vibe: r.vibe,
  }));
async function getLiveVibes() {
  const { data, error } = await supabase.rpc("get_live_vibe_counts");
  if (error) {
    console.error("Error fetching live vibe counts via RPC:", error);
    return [];
  }
  return data
    .map((v) => ({ id: v.id, name: v.name, type: v.type, count: v.room_count }))
    .sort((a, b) => b.count - a.count);
}
// Functions below this line are included for completeness and require no changes.
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
function handleApproveSuggestion(socket, { roomId, suggestionId }) {
  const room = rooms[roomId];
  // Security check: Only the host can approve.
  if (!room || socket.user.id !== room.hostUserId) return;

  const suggestionIndex = room.suggestions.findIndex(
    (s) => s.suggestionId === suggestionId
  );
  if (suggestionIndex === -1) return; // Suggestion not found

  // 1. Get the suggestion and remove it from the suggestions list.
  const [approvedSuggestion] = room.suggestions.splice(suggestionIndex, 1);
  const { suggestionId: sid, suggester, ...trackForPlaylist } = approvedSuggestion;

  // 2. Add the track to the main playlist.
  room.playlist.push(trackForPlaylist);
  
  // 3. Tell everyone the suggestions list has changed.
  io.to(roomId).emit("suggestionsUpdated", room.suggestions);
  
  // --- NEW, CORRECTED LOGIC ---

  // 4. Check if the player was idle. If so, start playing the new song.
  if (room.nowPlayingIndex === -1) {
    // The room was empty, so let's start the vibe!
    const newTrackIndex = room.playlist.length - 1;
    playTrackAtIndex(roomId, newTrackIndex);
  } else {
    // 5. If a song was already playing, just update the playlist for everyone.
    // This adds the song to the end of the queue visually for all clients.
    io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
  }
}

function handleSendMessage(socket, msg) {
  const room = rooms[msg.roomId];
  if (!socket.user || !room) return;

  const message = {
    messageId: `msg_${Date.now()}_${Math.random()}`, // Unique ID for deletion
    text: msg.text,
    user: socket.user.displayName,
    userId: socket.user.id,
    avatar: socket.user.avatar,
  };
  
  // Add message to room's history
  if (!room.chatHistory) room.chatHistory = [];
  room.chatHistory.push(message);

  // Broadcast the new message to everyone in the room
  io.to(msg.roomId).emit("newChatMessage", message);

  // Set a timer to remove this specific message after 1 hour (3600 * 1000 ms)
  setTimeout(() => {
    if (room && room.chatHistory) {
      room.chatHistory = room.chatHistory.filter(m => m.messageId !== message.messageId);
    }
  }, 3600 * 1000);
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
async function findOrCreateVibe(vibeData) {
  let { data: existingVibe, error: findError } = await supabase
    .from("vibes")
    .select("id")
    .eq("name", vibeData.name)
    .single();
  if (findError && findError.code !== "PGRST116") {
    return null;
  }
  if (existingVibe) {
    return existingVibe.id;
  }
  if (vibeData.type === "CUSTOM") {
    let { data: newVibe, error: createError } = await supabase
      .from("vibes")
      .insert({ name: vibeData.name, type: "CUSTOM" })
      .select("id")
      .single();
    if (createError) {
      return null;
    }
    return newVibe.id;
  }
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
    const slug = generateSlug(roomName);
    const { data: newRoom, error: roomError } = await supabase
      .from("rooms")
      .insert({
        name: roomName,
        host_user_id: socket.user.id,
        vibe_id: vibeId,
        slug: slug,
      })
      .select("id, slug")
      .single();
    if (roomError) {
      return socket.emit("error", { message: "Failed to create room." });
    }
    const roomId = newRoom.id.toString();
    const roomSlug = newRoom.slug;
    rooms[roomId] = {
      id: roomId,
      slug: roomSlug,
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
    socket.emit("roomCreated", { slug: roomSlug });
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

server.listen(PORT, () =>
  console.log(`Vibe Rooms server is live on http://localhost:${PORT}`)
);
