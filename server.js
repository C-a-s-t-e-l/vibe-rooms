const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const SpotifyWebApi = require('spotify-web-api-node');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const spotifyApi = new SpotifyWebApi({
    clientId: 'e006623e317742ceb990e14d2877c153',
    clientSecret: '3ee1dbb15f484ad791153d29733e27b9',
    redirectUri: 'http://127.0.0.1:3000/callback'
});

let rooms = {};
let userSockets = {};

// --- NEW: Tell Express where to serve static files from ---
app.use(express.static(path.join(__dirname, 'public')));

// --- NEW: Express Routes for Serving HTML Pages ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/index.html'));
});

app.get('/room/:roomId', (req, res) => {
    // We'll just serve the generic room page.
    // The front-end JS will handle fetching the specific room data.
    res.sendFile(path.join(__dirname, 'views/room.html'));
});

app.get('/login', (req, res) => {
    const scopes = [
        'streaming',
        'user-read-private',
        'user-read-email',
        'user-modify-playback-state'
    ];
    res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', (req, res) => {
    const error = req.query.error;
    const code = req.query.code;

    if (error) {
        console.error('Callback Error:', error);
        res.send(`Callback Error: ${error}`);
        return;
    }

    spotifyApi.authorizationCodeGrant(code).then(data => {
        const access_token = data.body['access_token'];
        const refresh_token = data.body['refresh_token'];
        res.redirect(`/#access_token=${access_token}&refresh_token=${refresh_token}`);
    }).catch(error => {
        console.error('Error getting Tokens:', error);
        res.send(`Error getting Tokens: ${error}`);
    });
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('getRooms', () => {
        socket.emit('updateRoomsList', Object.values(rooms).map(room => ({
            id: room.id,
            name: room.name,
            listenerCount: room.listeners.length
        })));
    });

    socket.on('createRoom', ({ roomName, spotifyUser }) => {
    const roomId = `room_${Date.now()}`;
    rooms[roomId] = {
        id: roomId,
        name: roomName,
        listeners: [],
        queue: [],
        nowPlaying: null,
        host: spotifyUser.id
    };
    
    // Announce the new room to everyone in the lobby
    io.emit('updateRoomsList', Object.values(rooms).map(room => ({
        id: room.id,
        name: room.name,
        listenerCount: room.listeners.length,
        nowPlaying: room.nowPlaying
    })));
    
    // Tell the creator the new room's ID so their browser can redirect
    socket.emit('roomCreated', { roomId }); 
});

    socket.on('joinRoom', ({ roomId, spotifyUser }) => {
        handleJoinRoom(socket, { roomId, spotifyUser });
    });

    socket.on('sendMessage', ({ roomId, message, userName }) => {
        io.to(roomId).emit('newChatMessage', { user: userName, text: message });
    });

    socket.on('addSong', ({ roomId, trackId, token }) => { // <-- Note the new "token" parameter
    if (!rooms[roomId]) return;

    // Temporarily set the access token on the server-side API instance
    spotifyApi.setAccessToken(token);

    spotifyApi.getTrack(trackId).then(data => {
        const track = {
            id: data.body.id,
            name: data.body.name,
            artist: data.body.artists[0].name,
            albumArt: data.body.album.images[0].url,
            duration_ms: data.body.duration_ms,
            uri: data.body.uri
        };
        rooms[roomId].queue.push(track);
        io.to(roomId).emit('queueUpdated', rooms[roomId].queue);
        
        if (!rooms[roomId].nowPlaying) {
            playNextSong(roomId);
        }
        // IMPORTANT: Reset the token so we don't accidentally use an old one
        spotifyApi.resetAccessToken(); 
    }).catch(err => {
        console.error('Error fetching track with user token:', err.message);
        spotifyApi.resetAccessToken();
    });
});

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const user = userSockets[socket.id];
        if (user && user.roomId && rooms[user.roomId]) {
            handleLeaveRoom(socket);
        }
        delete userSockets[socket.id];
    });
});

// server.js

// Replace the old version with this
function handleJoinRoom(socket, { roomId, spotifyUser }) {
    if (!rooms[roomId]) {
        // This can happen if the user tries to join a room that was just deleted
        socket.emit('error', { message: 'Room not found. It may have been closed.' });
        return;
    }

    // If the user is already in another room, make them leave it first
    const oldRoomId = userSockets[socket.id]?.roomId;
    if (oldRoomId && oldRoomId !== roomId) {
        handleLeaveRoom(socket);
    }

    // Join the new room
    socket.join(roomId);
    rooms[roomId].listeners.push(socket.id);
    userSockets[socket.id] = { 
        id: socket.id, 
        spotifyId: spotifyUser.id,
        name: spotifyUser.display_name, 
        roomId 
    };

    // Announce the new listener count to everyone in the lobby
    io.emit('updateRoomsList', Object.values(rooms).map(room => ({
        id: room.id,
        name: room.name,
        listenerCount: room.listeners.length,
        nowPlaying: room.nowPlaying
    })));

    // Send the complete current state of the room to the newly joined user
    socket.emit('roomState', {
        id: rooms[roomId].id,
        name: rooms[roomId].name,
        host: rooms[roomId].host,
        queue: rooms[roomId].queue,
        nowPlaying: rooms[roomId].nowPlaying
    });
    
    // Announce the arrival in the room's chat
    io.to(roomId).emit('newChatMessage', { system: true, text: `${spotifyUser.display_name} has joined the vibe.` });
}

function handleLeaveRoom(socket) {
    const user = userSockets[socket.id];
    if (!user || !user.roomId || !rooms[user.roomId]) return;

    const roomId = user.roomId;
    socket.leave(roomId);
    
    rooms[roomId].listeners = rooms[roomId].listeners.filter(id => id !== socket.id);
    io.to(roomId).emit('newChatMessage', { system: true, text: `${user.name} has left the vibe.` });

    if (rooms[roomId].listeners.length === 0) {
        setTimeout(() => {
            if (rooms[roomId] && rooms[roomId].listeners.length === 0) {
                console.log(`Deleting empty room: ${rooms[roomId].name}`);
                delete rooms[roomId];
                io.emit('updateRoomsList', Object.values(rooms).map(room => ({
                    id: room.id,
                    name: room.name,
                    listenerCount: room.listeners.length
                })));
            }
        }, 100000);
    } else {
        io.emit('updateRoomsList', Object.values(rooms).map(room => ({
            id: room.id,
            name: room.name,
            listenerCount: room.listeners.length
        })));
    }
    
    delete userSockets[socket.id].roomId;
}

function playNextSong(roomId) {
    const room = rooms[roomId];
    if (!room || room.queue.length === 0) {
        if(room) room.nowPlaying = null;
        io.to(roomId).emit('playbackEnded');
        return;
    }

    const nextTrack = room.queue.shift();
    room.nowPlaying = {
        track: nextTrack,
        startTime: Date.now()
    };
    
    io.to(roomId).emit('newSongPlaying', room.nowPlaying);
    io.to(roomId).emit('queueUpdated', room.queue);

    setTimeout(() => {
        playNextSong(roomId);
    }, nextTrack.duration_ms + 1000);
}

server.listen(PORT, () => {
    console.log(`Vibe Rooms server is live and vibing on http://127.0.0.1:${PORT}`);
});