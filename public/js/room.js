// public/js/room.js - The In-Room Script

let spotifyPlayer;
const spotifyApi = new SpotifyWebApi();

function initializePlayer(token) {
    if (spotifyPlayer) return;
    spotifyPlayer = new Spotify.Player({
        name: 'Vibe Rooms Player',
        getOAuthToken: cb => { cb(token); }
    });
    spotifyPlayer.addListener('ready', ({ device_id }) => console.log('Room Player is ready with Device ID', device_id));
    spotifyPlayer.connect();
}

window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('Spotify SDK for Room is ready.');
    const token = localStorage.getItem('spotifyAccessToken');
    if (token) {
        initializePlayer(token);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    console.log('Room script loaded.');
    const socket = io();
    let currentUser;
    let currentRoomId = window.location.pathname.split('/').pop();

    // --- DOM Elements ---
    const roomNameDisplay = document.getElementById('room-name-display');
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const searchForm = document.getElementById('search-form');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const queueList = document.getElementById('queue-list');
    const nowPlayingText = document.getElementById('now-playing-text');

    // --- Authentication & Joining ---
    const token = localStorage.getItem('spotifyAccessToken');
    if (!token) {
        window.location.href = '/';
        return;
    }
    
    spotifyApi.setAccessToken(token);

    spotifyApi.getMe().then(user => {
        currentUser = user;
        socket.emit('joinRoom', { roomId: currentRoomId, spotifyUser: currentUser });
    }).catch(() => {
        localStorage.removeItem('spotifyAccessToken');
        window.location.href = '/';
    });

    // --- UI Update Helper Functions ---
 // public/js/room.js

function updateQueueUI(queue) {
    const queueList = document.getElementById('queue-list');
    if (!queueList) return;
    queueList.innerHTML = '';
    if (!queue || queue.length === 0) {
        queueList.innerHTML = '<p class="system-message">Queue is empty. Add a song!</p>';
        return;
    }
    queue.forEach(track => {
        // NEW HTML structure for a track item
        queueList.innerHTML += `
        <div class="track-item">
            <img src="${track.albumArt}" alt="${track.name}">
            <div class="track-item-info">
                <p class="track-name">${track.name}</p>
                <p class="track-artist">${track.artist}</p>
            </div>
        </div>`;
    });
}

function updateNowPlayingUI(nowPlaying) {
    const art = document.getElementById('now-playing-art');
    const name = document.getElementById('now-playing-name');
    const artist = document.getElementById('now-playing-artist');
    if (!art || !name || !artist) return;

    if (!nowPlaying || !nowPlaying.track) {
        art.src = '/assets/placeholder.svg';
        name.textContent = 'Nothing is playing...';
        artist.textContent = '';
        return;
    }
    art.src = nowPlaying.track.albumArt;
    name.textContent = nowPlaying.track.name;
    artist.textContent = nowPlaying.track.artist;
}

function displaySearchResults(tracks) {
    const searchResults = document.getElementById('search-results');
    searchResults.innerHTML = '';
    tracks.forEach(track => {
        // NEW HTML structure for a search result item
        const resultDiv = document.createElement('div');
        resultDiv.className = 'track-item is-search-result';
        resultDiv.innerHTML = `
            <img src="${track.album.images[2]?.url || 'https://img.freepik.com/premium-vector/glowing-neon-music-note-icon-colorful-music-sign-glowing-neon-vector-illustration_561158-2743.jpg'}" alt="${track.name}">
            <div class="track-item-info">
                <p class="track-name">${track.name}</p>
                <p class="track-artist">${track.artists[0].name}</p>
            </div>`;
        
        resultDiv.onclick = () => {
            socket.emit('addSong', { 
                roomId: currentRoomId, 
                trackId: track.id,
                token: spotifyApi.getAccessToken()
            });
            searchResults.innerHTML = '';
            document.getElementById('search-input').value = '';
        };
        searchResults.appendChild(resultDiv);
    });
}

    // --- Form Handlers ---
    chatForm.onsubmit = (e) => {
        e.preventDefault();
        const message = chatInput.value;
        if (message.trim() !== '') {
            socket.emit('sendMessage', { roomId: currentRoomId, message: message, userName: currentUser.display_name });
            chatInput.value = '';
        }
    };
    
    searchForm.onsubmit = (e) => {
        e.preventDefault();
        const query = searchInput.value;
        if (query.trim() !== '') {
            spotifyApi.searchTracks(query, { limit: 5 }).then(data => displaySearchResults(data.tracks.items));
        }
    };
    
    // --- Incoming Socket Events ---
    socket.on('roomState', (data) => {
        console.log('Received initial room state:', data);
        roomNameDisplay.textContent = data.name;
        updateQueueUI(data.queue);
        updateNowPlayingUI(data.nowPlaying);
    });

    socket.on('newChatMessage', (message) => {
        if (!chatMessages) return;
        const messageEl = document.createElement('p');
        if (message.system) {
            messageEl.className = 'system-message';
            messageEl.textContent = message.text;
        } else {
            messageEl.className = 'user-message';
            messageEl.innerHTML = `<strong>${message.user}:</strong> ${message.text}`;
        }
        chatMessages.appendChild(messageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });

    socket.on('queueUpdated', (queue) => {
        updateQueueUI(queue);
    });

    socket.on('newSongPlaying', (nowPlaying) => {
        updateNowPlayingUI(nowPlaying);
        if (!spotifyPlayer || !nowPlaying || !nowPlaying.track) return;
        const latency = Date.now() - nowPlaying.startTime;
        spotifyPlayer._options.getOAuthToken(access_token => {
            fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyPlayer._options.id}`, {
                method: 'PUT',
                body: JSON.stringify({ uris: [nowPlaying.track.uri], position_ms: latency }),
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
            });
        });
    });

});