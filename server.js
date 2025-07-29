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
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// This is just a base configuration, we will create new instances for user requests.
const spotifyApiConfig = {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
};

let rooms = {};
let userSockets = {};

app.use(express.static(path.join(__dirname, 'public')));

// --- Express Routes ---
app.get('/login', (req, res) => {
    const scopes = ['streaming', 'user-read-private', 'user-read-email', 'user-modify-playback-state'];
    const spotifyApi = new SpotifyWebApi(spotifyApiConfig); // Use a temporary instance
    res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', (req, res) => {
    const code = req.query.code || null;
    const spotifyApi = new SpotifyWebApi(spotifyApiConfig); // Use a temporary instance
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
    console.log(`A user connected: ${socket.id}`);
    
    socket.on('getRooms', () => socket.emit('updateRoomsList', getPublicRoomsData()));
    socket.on('createRoom', ({ roomName, spotifyUser }) => handleCreateRoom(socket, roomName, spotifyUser));
    socket.on('joinRoom', ({ roomId, spotifyUser }) => handleJoinRoom(socket, roomId, spotifyUser));
    socket.on('sendMessage', (msg) => io.to(msg.roomId).emit('newChatMessage', msg));
    socket.on('addSong', handleAddSpotifyTrack);
    socket.on('addPlaylist', handleAddPlaylist);
    socket.on('addYouTubeTrack', handleAddYouTubeTrack);
    socket.on('skipTrack', (data) => {
        const room = rooms[data.roomId];
        if (room && userSockets[socket.id]?.spotifyId === room.host) {
            playNextSong(data.roomId);
        }
    });
    socket.on('disconnect', () => handleLeaveRoom(socket));
});

// --- Main Handler Functions ---

function handleCreateRoom(socket, roomName, spotifyUser) {
    const roomId = `room_${Date.now()}`;
    rooms[roomId] = {
        id: roomId, name: roomName, host: spotifyUser.id,
        listeners: new Set(), queue: [], nowPlaying: null,
        songEndTimer: null, deletionTimer: null
    };
    socket.emit('roomCreated', { roomId });
    io.emit('updateRoomsList', getPublicRoomsData());
    console.log(`Room created: ${roomName} (ID: ${roomId}) by ${spotifyUser.display_name}`);
}

function handleJoinRoom(socket, roomId, spotifyUser) {
    const room = rooms[roomId];
    if (!room) {
        console.error(`JOIN FAILED: User ${spotifyUser.display_name} tried to join non-existent room ${roomId}`);
        socket.emit('roomJoinError', { message: `The Vibe Room you tried to join no longer exists.` });
        return;
    }

    if (room.deletionTimer) clearTimeout(room.deletionTimer);
    room.deletionTimer = null;

    socket.join(roomId);
    room.listeners.add(socket.id);
    userSockets[socket.id] = { id: socket.id, spotifyId: spotifyUser.id, name: spotifyUser.display_name, roomId };

    // Send the state AND the current song to the user who just joined
    socket.emit('roomState', getSanitizedRoomState(room));
    if (room.nowPlaying) {
        socket.emit('newSongPlaying', room.nowPlaying);
    }
    
    io.to(roomId).emit('newChatMessage', { system: true, text: `${spotifyUser.display_name} has joined the vibe.` });
    io.emit('updateRoomsList', getPublicRoomsData());
    console.log(`${spotifyUser.display_name} joined room: ${room.name}`);
}

function handleLeaveRoom(socket) {
    const user = userSockets[socket.id];
    if (!user) return;

    const room = rooms[user.roomId];
    if (room) {
        room.listeners.delete(socket.id);
        io.to(user.roomId).emit('newChatMessage', { system: true, text: `${user.name} has left the vibe.` });
        if (room.listeners.size === 0) {
            console.log(`Room ${room.name} is empty. Setting deletion timer.`);
            room.deletionTimer = setTimeout(() => {
                if (rooms[user.roomId]?.listeners.size === 0) {
                    console.log(`Deleting empty room: ${room.name}`);
                    if (room.songEndTimer) clearTimeout(room.songEndTimer);
                    delete rooms[user.roomId];
                    io.emit('updateRoomsList', getPublicRoomsData());
                }
            }, 5 * 60 * 1000); // 5 minutes
        }
    }
    delete userSockets[socket.id];
    io.emit('updateRoomsList', getPublicRoomsData());
    console.log(`User ${user.name} disconnected.`);
}

async function handleAddSpotifyTrack({ roomId, trackId, token }) {
    const room = rooms[roomId];
    if (!room || !token) return;

    // FIX: Create a user-specific API instance for this request
    const userSpotifyApi = new SpotifyWebApi(spotifyApiConfig);
    userSpotifyApi.setAccessToken(token);

    try {
        const { body } = await userSpotifyApi.getTrack(trackId);
        const track = {
            id: body.id, name: body.name, artist: body.artists.map(a => a.name).join(', '),
            albumArt: body.album.images[0]?.url, duration_ms: body.duration_ms,
            uri: body.uri, source: 'spotify'
        };
        room.queue.push(track);
        io.to(roomId).emit('queueUpdated', room.queue);
        if (!room.nowPlaying) playNextSong(roomId);
    } catch (e) { console.error(`Error adding Spotify track for user: ${e.message}`); }
}

async function handleAddPlaylist({ roomId, playlistId, token }) {
    const room = rooms[roomId];
    if (!room || !token) return;

    // FIX: Create a user-specific API instance for this request
    const userSpotifyApi = new SpotifyWebApi(spotifyApiConfig);
    userSpotifyApi.setAccessToken(token);

    try {
        const { body } = await userSpotifyApi.getPlaylistTracks(playlistId, {
            fields: 'items(track(id,name,artists(name),album(images),duration_ms,uri))'
        });
        const tracks = body.items.map(item => {
            if (!item.track) return null;
            return {
                id: item.track.id, name: item.track.name, artist: item.track.artists.map(a => a.name).join(', '),
                albumArt: item.track.album.images[0]?.url, duration_ms: item.track.duration_ms,
                uri: item.track.uri, source: 'spotify'
            };
        }).filter(Boolean);
        room.queue.push(...tracks);
        io.to(roomId).emit('queueUpdated', room.queue);
        if (!room.nowPlaying) playNextSong(roomId);
    } catch (e) { console.error(`Error adding Spotify playlist for user: ${e.message}`); }
}

async function handleAddYouTubeTrack({ roomId, videoId }) {
    const room = rooms[roomId];
    if (!room) return;
    console.log(`Attempting to extract direct audio for YouTube video: ${videoId}`);

    try {
        // This mimics the youtube-dl/yt-dlp approach by calling the internal player API
        const response = await axios.post(`https://www.youtube.com/youtubei/v1/player?key=${YOUTUBE_API_KEY}`, {
            context: {
                client: {
                    clientName: "WEB",
                    clientVersion: "2.20210721.00.00",
                },
            },
            videoId: videoId,
        });

        const playerResponse = response.data;
        
        // Find the best audio-only format
        const audioFormats = playerResponse.streamingData?.adaptiveFormats?.filter(f => f.mimeType.startsWith('audio/'));
        if (!audioFormats || audioFormats.length === 0) {
            console.error(`No audio formats found for YouTube video ${videoId}`);
            return;
        }

        // Prefer opus, but fallback to anything
        const bestAudio = audioFormats.find(f => f.mimeType.includes('opus')) || audioFormats[0];
        
        const videoDetails = playerResponse.videoDetails;
        const durationMs = parseInt(videoDetails.lengthSeconds) * 1000;

        const track = {
            id: videoDetails.videoId,
            name: videoDetails.title,
            artist: videoDetails.author,
            albumArt: videoDetails.thumbnail.thumbnails.pop().url, // Get highest quality thumbnail
            duration_ms: durationMs,
            source: 'youtube',
            // CRITICAL: We now store the direct audio URL
            url: bestAudio.url,
        };

        room.queue.push(track);
        io.to(roomId).emit('queueUpdated', room.queue);
        if (!room.nowPlaying) playNextSong(roomId);

    } catch (e) {
        console.error("Error extracting YouTube audio stream:", e.response?.data?.error || e.message);
    }
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

    io.to(roomId).emit('newSongPlaying', room.nowPlaying);
    io.to(roomId).emit('queueUpdated', room.queue);
    io.emit('updateRoomsList', getPublicRoomsData());

    room.songEndTimer = setTimeout(() => playNextSong(roomId), nextTrack.duration_ms + 1000);
}

// --- Helper Functions ---
const getPublicRoomsData = () => Object.values(rooms).map(r => ({
    id: r.id, name: r.name, listenerCount: r.listeners.size, nowPlaying: r.nowPlaying
}));

const getSanitizedRoomState = (room) => {
    if (!room) return null;
    const { songEndTimer, deletionTimer, ...safeRoomState } = room;
    safeRoomState.listeners = Array.from(safeRoomState.listeners).length;
    return safeRoomState;
};

server.listen(PORT, () => console.log(`Vibe Rooms server is live on http://localhost:${PORT}`));