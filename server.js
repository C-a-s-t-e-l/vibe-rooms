// server.js (Final, Bulletproof Version)
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const SpotifyWebApi = require('spotify-web-api-node');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
});
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

let rooms = {};
let userSockets = {};

app.use(express.static(path.join(__dirname, 'public')));

// --- Express Routes ---
app.get('/login', (req, res) => {
    const scopes = ['streaming', 'user-read-private', 'user-read-email', 'user-modify-playback-state'];
    res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', (req, res) => {
    const code = req.query.code || null;
    spotifyApi.authorizationCodeGrant(code).then(data => {
        res.redirect(`/#access_token=${data.body['access_token']}`);
    }).catch(err => res.status(400).send('Error getting token'));
});

app.get('/room/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'room.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});


// --- Socket.IO Logic ---
io.on('connection', (socket) => {
    socket.on('getRooms', () => socket.emit('updateRoomsList', getPublicRoomsData()));
    socket.on('createRoom', ({ roomName, spotifyUser }) => {
        const roomId = `room_${Date.now()}`;
        rooms[roomId] = {
            id: roomId, name: roomName, host: spotifyUser.id,
            listeners: new Set(), queue: [], nowPlaying: null,
            songEndTimer: null, deletionTimer: null
        };
        socket.emit('roomCreated', { roomId });
        io.emit('updateRoomsList', getPublicRoomsData());
    });

    socket.on('joinRoom', ({ roomId, spotifyUser }) => handleJoinRoom(socket, roomId, spotifyUser));
    socket.on('sendMessage', (msg) => io.to(msg.roomId).emit('newChatMessage', msg));
    socket.on('addSong', (data) => handleAddSpotifyTrack(data));
    socket.on('addYouTubeTrack', (data) => handleAddYouTubeTrack(data));
    socket.on('skipTrack', (data) => {
        const room = rooms[data.roomId];
        if (room && userSockets[socket.id]?.spotifyId === room.host) {
            playNextSong(data.roomId);
        }
    });
    socket.on('disconnect', () => handleLeaveRoom(socket));
});

// --- Helper Functions ---

const getPublicRoomsData = () => Object.values(rooms).map(r => ({
    id: r.id, name: r.name, listenerCount: r.listeners.size, nowPlaying: r.nowPlaying
}));

// THE FIX #1: Create a clean "state" object without timers before sending to the client.
const getSanitizedRoomState = (room) => {
    if (!room) return null;
    // This creates a new object, copying everything EXCEPT the problematic timer properties.
    const { songEndTimer, deletionTimer, ...safeRoomState } = room;
    // Also, convert the Set of listeners to an array for JSON compatibility.
    safeRoomState.listeners = Array.from(safeRoomState.listeners);
    return safeRoomState;
};

async function handleAddSpotifyTrack({ roomId, trackId, token }) {
    // ... (This function is correct, no changes needed)
    const room = rooms[roomId];
    if (!room) return;
    try {
        spotifyApi.setAccessToken(token);
        const { body } = await spotifyApi.getTrack(trackId);
        const track = {
            id: body.id, name: body.name, artist: body.artists.map(a => a.name).join(', '),
            albumArt: body.album.images[0]?.url, duration_ms: body.duration_ms,
            uri: body.uri, source: 'spotify'
        };
        room.queue.push(track);
        io.to(roomId).emit('queueUpdated', room.queue);
        if (!room.nowPlaying) playNextSong(roomId);
    } catch (e) { console.error("Error adding Spotify track:", e.message); }
    finally { spotifyApi.resetAccessToken(); }
}

async function handleAddYouTubeTrack({ roomId, videoId }) {
    // ... (This function is correct, no changes needed)
    const room = rooms[roomId];
    if (!room || !YOUTUBE_API_KEY) return;
    try {
        const response = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
            params: { id: videoId, key: YOUTUBE_API_KEY, part: 'snippet,contentDetails' }
        });
        const video = response.data.items[0];
        if (!video) return;
        const durationRegex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
        const matches = video.contentDetails.duration.match(durationRegex);
        const durationMs = ((parseInt(matches[1] || 0) * 3600) + (parseInt(matches[2] || 0) * 60) + parseInt(matches[3] || 0)) * 1000;
        const track = {
            id: video.id, name: video.snippet.title, artist: video.snippet.channelTitle,
            albumArt: video.snippet.thumbnails.high.url, duration_ms: durationMs, source: 'youtube'
        };
        room.queue.push(track);
        io.to(roomId).emit('queueUpdated', room.queue);
        if (!room.nowPlaying) playNextSong(roomId);
    } catch (e) { console.error("Error adding YouTube track:", e.response?.data?.error || e.message); }
}


function playNextSong(roomId) {
    // ... (This function is correct, no changes needed)
    const room = rooms[roomId];
    if (!room) return;
    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.queue.length === 0) {
        room.nowPlaying = null;
        io.to(roomId).emit('newSongPlaying', null);
        io.emit('updateRoomsList', getPublicRoomsData());
        return;
    }
    const nextTrack = room.queue.shift();
    room.nowPlaying = { track: nextTrack, startTime: Date.now() };
    io.to(roomId).emit('newSongPlaying', room.nowPlaying);
    io.to(roomId).emit('queueUpdated', room.queue);
    io.emit('updateRoomsList', getPublicRoomsData());
    room.songEndTimer = setTimeout(() => playNextSong(roomId), nextTrack.duration_ms + 1000);
}

function handleJoinRoom(socket, roomId, spotifyUser) {
    if (userSockets[socket.id]?.roomId) handleLeaveRoom(socket, true); // Leave previous room if any
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'Room not found.' });

    if (room.deletionTimer) {
        clearTimeout(room.deletionTimer);
        room.deletionTimer = null;
    }

    socket.join(roomId);
    room.listeners.add(socket.id);
    userSockets[socket.id] = { id: socket.id, spotifyId: spotifyUser.id, name: spotifyUser.display_name, roomId };

    // THIS IS THE FIX for the crash. We send the sanitized state.
    socket.emit('roomState', getSanitizedRoomState(room));

    io.to(roomId).emit('newChatMessage', { system: true, text: `${spotifyUser.display_name} has joined the vibe.` });
    io.emit('updateRoomsList', getPublicRoomsData());
}

function handleLeaveRoom(socket) {
    const user = userSockets[socket.id];
    if (!user || !user.roomId) return;

    const roomId = user.roomId;
    const room = rooms[roomId];
    if (!room) return;

    socket.leave(roomId);
    room.listeners.delete(socket.id);
    delete userSockets[socket.id];

    io.to(roomId).emit('newChatMessage', { system: true, text: `${user.name} has left the vibe.` });

    // THE FIX #2: Wait 5 seconds before checking if the room is empty.
    // This gives the user time to reconnect on a page reload.
    setTimeout(() => {
        const currentRoom = rooms[roomId]; // Re-check room existence
        if (!currentRoom) return;

        // If after 5 seconds the room is truly empty, schedule it for permanent deletion.
        if (currentRoom.listeners.size === 0) {
            currentRoom.deletionTimer = setTimeout(() => {
                console.log(`Deleting empty room: ${currentRoom.name}`);
                delete rooms[roomId];
                io.emit('updateRoomsList', getPublicRoomsData());
            }, 30 * 60 * 1000); // 30-minute grace period
        }
        // Always update the lobby with the latest listener count.
        io.emit('updateRoomsList', getPublicRoomsData());
    }, 5000); // 5-second grace period for reloads.
}

server.listen(PORT, () => console.log(`Vibe Rooms server is live on http://localhost:${PORT}`));