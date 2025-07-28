// server.js (Corrected and Complete Version)
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
    console.log('A user connected:', socket.id);
    
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
        console.log(`Room created: ${roomName} (ID: ${roomId})`);
    });

    socket.on('joinRoom', ({ roomId, spotifyUser }) => handleJoinRoom(socket, roomId, spotifyUser));
    socket.on('sendMessage', (msg) => io.to(msg.roomId).emit('newChatMessage', msg));
    
    // Song/Playlist addition handlers
    socket.on('addSong', (data) => handleAddSpotifyTrack(data));
    socket.on('addYouTubeTrack', (data) => handleAddYouTubeTrack(data));
    socket.on('addPlaylist', (data) => handleAddPlaylist(data)); // <-- FIX: Added missing handler

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

const getSanitizedRoomState = (room) => {
    if (!room) return null;
    const { songEndTimer, deletionTimer, ...safeRoomState } = room;
    safeRoomState.listeners = Array.from(safeRoomState.listeners);
    return safeRoomState;
};

async function handleAddSpotifyTrack({ roomId, trackId, token }) {
    const room = rooms[roomId];
    if (!room || !token) return;
    console.log(`Attempting to add track ${trackId} to room ${roomId}`);
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
    } catch (e) { console.error("Error adding Spotify track:", e); }
    finally { spotifyApi.resetAccessToken(); }
}

async function handleAddYouTubeTrack({ roomId, videoId }) {
    const room = rooms[roomId];
    if (!room || !YOUTUBE_API_KEY) return;
    console.log(`Attempting to add YouTube video ${videoId} to room ${roomId}`);
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

// FIX: Added the entire missing function to handle playlists
async function handleAddPlaylist({ roomId, playlistId, token }) {
    const room = rooms[roomId];
    if (!room || !token) return;
    console.log(`Attempting to add playlist ${playlistId} to room ${roomId}`);
    try {
        spotifyApi.setAccessToken(token);
        const { body } = await spotifyApi.getPlaylistTracks(playlistId);
        const tracks = body.items.map(item => {
            const track = item.track;
            if (!track) return null;
            return {
                id: track.id, name: track.name, artist: track.artists.map(a => a.name).join(', '),
                albumArt: track.album.images[0]?.url, duration_ms: track.duration_ms,
                uri: track.uri, source: 'spotify'
            };
        }).filter(t => t !== null); // Filter out any null tracks

        room.queue.push(...tracks);
        io.to(roomId).emit('queueUpdated', room.queue);
        if (!room.nowPlaying) playNextSong(roomId);
    } catch (e) { console.error("Error adding Spotify playlist:", e); }
    finally { spotifyApi.resetAccessToken(); }
}

function playNextSong(roomId) {
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

    console.log(`Now playing in room ${roomId}: ${nextTrack.name}`);
    io.to(roomId).emit('newSongPlaying', room.nowPlaying);
    io.to(roomId).emit('queueUpdated', room.queue);
    io.emit('updateRoomsList', getPublicRoomsData());

    room.songEndTimer = setTimeout(() => playNextSong(roomId), nextTrack.duration_ms + 1000);
}

function handleJoinRoom(socket, roomId, spotifyUser) {
    if (userSockets[socket.id]?.roomId) handleLeaveRoom(socket, true);
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'Room not found.' });

    if (room.deletionTimer) {
        clearTimeout(room.deletionTimer);
        room.deletionTimer = null;
    }

    socket.join(roomId);
    room.listeners.add(socket.id);
    userSockets[socket.id] = { id: socket.id, spotifyId: spotifyUser.id, name: spotifyUser.display_name, roomId };

    socket.emit('roomState', getSanitizedRoomState(room));
    io.to(roomId).emit('newChatMessage', { system: true, text: `${spotifyUser.display_name} has joined the vibe.` });
    io.emit('updateRoomsList', getPublicRoomsData());
}

function handleLeaveRoom(socket) {
    const user = userSockets[socket.id];
    if (!user || !user.roomId) return;
    console.log('A user disconnected:', socket.id);

    const roomId = user.roomId;
    const room = rooms[roomId];
    if (!room) return;

    socket.leave(roomId);
    room.listeners.delete(socket.id);
    delete userSockets[socket.id];

    io.to(roomId).emit('newChatMessage', { system: true, text: `${user.name} has left the vibe.` });

    setTimeout(() => {
        const currentRoom = rooms[roomId];
        if (!currentRoom) return;
        if (currentRoom.listeners.size === 0) {
            currentRoom.deletionTimer = setTimeout(() => {
                console.log(`Deleting empty room: ${currentRoom.name} (ID: ${roomId})`);
                if (currentRoom.songEndTimer) clearTimeout(currentRoom.songEndTimer);
                delete rooms[roomId];
                io.emit('updateRoomsList', getPublicRoomsData());
            }, 30 * 60 * 1000);
        }
        io.emit('updateRoomsList', getPublicRoomsData());
    }, 5000);
}

server.listen(PORT, () => console.log(`Vibe Rooms server is live on http://localhost:${PORT}`));