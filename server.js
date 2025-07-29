// server.js (Definitive Final Version with Sync Pulse)
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
const SYNC_INTERVAL = 4000; // Broadcast a sync pulse every 4 seconds

let rooms = {};
let userSockets = {};

// --- Middleware and Routes (Unchanged) ---
const sessionMiddleware = session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { secure: false } });
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: "/auth/google/callback" }, (accessToken, refreshToken, profile, done) => done(null, profile)));
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));
app.use(express.static(path.join(__dirname, "public")));
const ensureAuthenticated = (req, res, next) => { if (req.isAuthenticated()) return next(); res.redirect("/"); };
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback", passport.authenticate("google", { failureRedirect: "/" }), (req, res) => res.redirect("/"));
app.get("/logout", (req, res, next) => { req.logout((err) => { if (err) return next(err); res.redirect("/"); }); });
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
io.use((socket, next) => { const user = socket.request.user; if (user) { socket.user = user; next(); } else { next(new Error('unauthorized')); } });

io.on("connection", (socket) => {
  socket.on("getRooms", () => socket.emit("updateRoomsList", getPublicRoomsData()));
  socket.on("createRoom", (roomName) => handleCreateRoom(socket, roomName));
  socket.on("joinRoom", (roomId) => handleJoinRoom(socket, roomId));
  socket.on("sendMessage", (msg) => handleSendMessage(socket, msg));
  socket.on("addYouTubeTrack", ({ roomId, videoId }) => handleAddYouTubeTrack(socket, roomId, videoId));
  socket.on("hostPlaybackChange", (data) => handleHostPlaybackChange(socket, data));
  socket.on("skipTrack", (data) => { if (rooms[data.roomId] && socket.id === rooms[data.roomId].host) playNextSong(data.roomId); });
  socket.on("disconnect", () => handleLeaveRoom(socket));
});


// --- Handler Functions (FINAL ARCHITECTURE) ---

function playTrack(roomId, track) {
    const room = rooms[roomId];
    if (!room || !track) return;
    
    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.syncInterval) clearInterval(room.syncInterval);

    room.nowPlaying = { track: track, startTime: Date.now(), position: 0 };
    room.isPlaying = true;

    io.to(roomId).emit('newSongPlaying', getAuthoritativeNowPlaying(room));
    io.emit('updateRoomsList', getPublicRoomsData());

    room.songEndTimer = setTimeout(() => playNextSong(roomId), track.duration_ms + 1500);
    
    // Start the Sync Pulse metronome
    room.syncInterval = setInterval(() => {
        if (room.isPlaying) {
            io.to(roomId).emit('syncPulse', getAuthoritativeNowPlaying(room));
        }
    }, SYNC_INTERVAL);
}

function handleHostPlaybackChange(socket, data) {
    const room = rooms[data.roomId];
    if (room && socket.id === room.host && room.nowPlaying) {
        room.isPlaying = data.isPlaying;

        if (!data.isPlaying) { // Pausing
            room.nowPlaying.position = Date.now() - room.nowPlaying.startTime;
            if(room.syncInterval) clearInterval(room.syncInterval);
        } else { // Resuming play
            room.nowPlaying.startTime = Date.now() - (room.nowPlaying.position || 0);
            if(room.syncInterval) clearInterval(room.syncInterval);
            room.syncInterval = setInterval(() => { io.to(data.roomId).emit('syncPulse', getAuthoritativeNowPlaying(room)); }, SYNC_INTERVAL);
        }

        if (data.position !== undefined) { // Seeking
            room.nowPlaying.position = data.position;
            room.nowPlaying.startTime = Date.now() - data.position;
        }
        
        // Send an immediate sync event so clients don't have to wait for the next pulse
        io.to(data.roomId).emit('syncPulse', getAuthoritativeNowPlaying(room));
    }
}

function playNextSong(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.syncInterval) clearInterval(room.syncInterval);

    if (room.queue.length === 0) {
        room.nowPlaying = null; room.isPlaying = false;
        io.to(roomId).emit('newSongPlaying', null);
        io.emit('updateRoomsList', getPublicRoomsData());
        return;
    }
    const nextTrack = room.queue.shift();
    io.to(roomId).emit('queueUpdated', room.queue);
    playTrack(roomId, nextTrack);
}

const getAuthoritativeNowPlaying = (room) => {
    if (!room || !room.nowPlaying) return null;
    
    // THE FIX: We are adding a `serverTimestamp` to every sync object.
    const authoritativeState = { 
        ...room.nowPlaying, 
        isPlaying: room.isPlaying, 
        serverTimestamp: Date.now() // Add the current server time
    };

    if (room.isPlaying) {
        authoritativeState.position = Date.now() - authoritativeState.startTime;
    }
    // If paused, `authoritativeState.position` already holds the correct value.

    return authoritativeState;
};

async function handleAddYouTubeTrack(socket, roomId, videoId) { const room = rooms[roomId]; if (!room) return; const tempId = `processing_${videoId}_${Date.now()}`; const placeholderTrack = { id: tempId, name: 'Loading Vibe...', artist: 'Please wait...', status: 'processing' }; room.queue.push(placeholderTrack); io.to(roomId).emit("queueUpdated", room.queue); try { const videoUrl = `https://www.youtube.com/watch?v=${videoId}`; const info = await ytDlpExec(videoUrl, { dumpSingleJson: true, format: "bestaudio/best" }); const track = { videoId: info.id, name: info.title, artist: info.uploader || info.channel, albumArt: info.thumbnails?.pop()?.url || '/assets/placeholder.svg', duration_ms: info.duration * 1000, url: info.url, source: 'youtube', }; room.queue = room.queue.filter(t => t.id !== tempId); if (!room.nowPlaying) { playTrack(roomId, track); io.to(roomId).emit("queueUpdated", room.queue); } else { room.queue.push(track); io.to(roomId).emit("queueUpdated", room.queue); } } catch (e) { room.queue = room.queue.filter(t => t.id !== tempId); io.to(roomId).emit("queueUpdated", room.queue); socket.emit("newChatMessage", { system: true, text: "Sorry, that YouTube link could not be processed." }); } }
function handleJoinRoom(socket, roomId) { const room = rooms[roomId]; if (!room) return; if (room.deletionTimer) clearTimeout(room.deletionTimer); room.deletionTimer = null; socket.join(roomId); room.listeners.add(socket.id); userSockets[socket.id] = { id: socket.id, user: socket.user, roomId }; const isHost = room.host === socket.id; socket.emit("roomState", getSanitizedRoomState(room, isHost, socket.user)); if (room.nowPlaying) { socket.emit("newSongPlaying", getAuthoritativeNowPlaying(room)); } io.to(roomId).emit("newChatMessage", { system: true, text: `${socket.user.displayName} has joined the vibe.`, }); io.emit("updateRoomsList", getPublicRoomsData()); }
function handleLeaveRoom(socket) { const userSocket = userSockets[socket.id]; if (!userSocket) return; const room = rooms[userSocket.roomId]; if (room) { room.listeners.delete(socket.id); io.to(userSocket.roomId).emit("newChatMessage", { system: true, text: `${socket.user.displayName} has left the vibe.`, }); if (socket.id === room.host && room.listeners.size > 0) { const newHostId = Array.from(room.listeners)[0]; room.host = newHostId; const newHostSocket = userSockets[newHostId]; io.to(userSocket.roomId).emit("newChatMessage", { system: true, text: `👑 ${newHostSocket.user.displayName} is now the host.` }); io.to(newHostId).emit("hostAssigned"); } if (room.listeners.size === 0) { room.deletionTimer = setTimeout(() => { if (rooms[userSocket.roomId]?.listeners.size === 0) { if (room.songEndTimer) clearTimeout(room.songEndTimer); if (room.syncInterval) clearInterval(room.syncInterval); delete rooms[userSocket.roomId]; io.emit("updateRoomsList", getPublicRoomsData()); } }, 30 * 1000); } } delete userSockets[socket.id]; io.emit("updateRoomsList", getPublicRoomsData()); }
function handleSendMessage(socket, msg) { if (!socket.user) return; let avatarUrl = socket.user.photos[0].value; if (avatarUrl.includes('?sz=')) { avatarUrl = avatarUrl.replace(/\?sz=\d+$/, '?sz=128'); } else if (avatarUrl.includes('=s')) { avatarUrl = avatarUrl.replace(/=s\d+.*$/, '=s128-c'); } const message = { text: msg.text, user: socket.user.displayName, userId: socket.user.id, avatar: avatarUrl }; io.to(msg.roomId).emit("newChatMessage", message); }
function handleCreateRoom(socket, roomName) { const roomId = `room_${Date.now()}`; rooms[roomId] = { id: roomId, name: roomName, host: socket.id, listeners: new Set(), queue: [], nowPlaying: null, songEndTimer: null, deletionTimer: null, isPlaying: false, }; socket.emit("roomCreated", { roomId }); io.emit("updateRoomsList", getPublicRoomsData()); }
const getPublicRoomsData = () => Object.values(rooms).map((r) => ({ id: r.id, name: r.name, listenerCount: r.listeners.size, nowPlaying: r.nowPlaying, }));
const getSanitizedRoomState = (room, isHost, user) => { if (!room) return null; const { songEndTimer, deletionTimer, syncInterval, listeners, ...safeRoomState } = room; safeRoomState.listenerCount = listeners.size; safeRoomState.isHost = isHost; safeRoomState.currentUser = { name: user.displayName, id: user.id, avatar: user.photos[0].value }; safeRoomState.nowPlaying = getAuthoritativeNowPlaying(room); safeRoomState.isPlaying = room.isPlaying; return safeRoomState; };

server.listen(PORT, () => console.log(`Vibe Rooms server is live on http://localhost:${PORT}`));