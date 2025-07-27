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

app.use(express.static(path.join(__dirname, '/')));

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
        io.emit('updateRoomsList', Object.values(rooms).map(room => ({
            id: room.id,
            name: room.name,
            listenerCount: room.listeners.length
        })));
        handleJoinRoom(socket, { roomId, spotifyUser });
    });

    socket.on('joinRoom', ({ roomId, spotifyUser }) => {
        handleJoinRoom(socket, { roomId, spotifyUser });
    });

    socket.on('sendMessage', ({ roomId, message, userName }) => {
        io.to(roomId).emit('newChatMessage', { user: userName, text: message });
    });

    socket.on('addSong', ({ roomId, trackId }) => {
        if (!rooms[roomId]) return;

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
        }).catch(err => console.error('Error fetching track:', err));
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

function handleJoinRoom(socket, { roomId, spotifyUser }) {
    if (!rooms[roomId]) {
        socket.emit('error', { message: 'Room not found' });
        return;
    }

    const oldRoomId = userSockets[socket.id]?.roomId;
    if (oldRoomId) {
        handleLeaveRoom(socket);
    }

    socket.join(roomId);
    rooms[roomId].listeners.push(socket.id);
    userSockets[socket.id] = { 
        id: socket.id, 
        spotifyId: spotifyUser.id,
        name: spotifyUser.display_name, 
        roomId 
    };

    io.emit('updateRoomsList', Object.values(rooms).map(room => ({
        id: room.id,
        name: room.name,
        listenerCount: room.listeners.length
    })));

    socket.emit('joinedRoom', {
        room: {
            id: rooms[roomId].id,
            name: rooms[roomId].name,
            host: rooms[roomId].host
        },
        queue: rooms[roomId].queue,
        nowPlaying: rooms[roomId].nowPlaying
    });
    
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
        }, 60000);
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