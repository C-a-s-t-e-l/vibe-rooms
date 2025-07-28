// public/js/main.js - The Lobby Script

let spotifyPlayer;
const spotifyApi = new SpotifyWebApi();

function initializePlayer(token) {
    if (spotifyPlayer) return;
    spotifyPlayer = new Spotify.Player({ name: 'Vibe Rooms Player', getOAuthToken: cb => { cb(token); } });
    spotifyPlayer.addListener('ready', ({ device_id }) => console.log('Lobby Player is ready with Device ID', device_id));
    spotifyPlayer.connect();
}

window.onSpotifyWebPlaybackSDKReady = () => {
    const token = localStorage.getItem('spotifyAccessToken');
    if (token) initializePlayer(token);
};

document.addEventListener('DOMContentLoaded', () => {
    console.log('Lobby script loaded.');
    const socket = io();
    let currentUser;

    const navActions = document.querySelector('.nav-actions');
    const heroSection = document.querySelector('.hero');
    const roomsSection = document.querySelector('.rooms-section');
    const roomsGrid = document.querySelector('.rooms-grid');

    const urlToken = new URLSearchParams(window.location.hash.substring(1)).get('access_token');
    const storedToken = localStorage.getItem('spotifyAccessToken');
    const tokenToUse = urlToken || storedToken;

    if (urlToken) {
        localStorage.setItem('spotifyAccessToken', urlToken);
        window.history.pushState({}, document.title, "/");
    }

    if (tokenToUse) {
        spotifyApi.setAccessToken(tokenToUse);
        setupLoggedInUI(tokenToUse);
    }

    function setupLoggedInUI(token) {
        heroSection.style.display = 'none';
        roomsSection.style.display = 'block';
        navActions.innerHTML = `<p class="nav-link" id="welcome-message">Welcome!</p>`;
        const welcomeMessage = document.getElementById('welcome-message');

        spotifyApi.getMe().then(user => {
            currentUser = user;
            welcomeMessage.textContent = `Welcome, ${currentUser.display_name}`;
        }).catch(() => {
            localStorage.removeItem('spotifyAccessToken');
            window.location.href = '/';
        });

        if (typeof Spotify !== 'undefined') initializePlayer(token);
        socket.emit('getRooms');
    }

   // public/js/main.js

socket.on('updateRoomsList', (rooms) => {
    roomsGrid.innerHTML = '';
    if (rooms.length === 0) {
        roomsGrid.innerHTML = '<p style="text-align: center; color: hsl(var(--muted-foreground));">No active vibes... Be the first to start one!</p>';
    }
    rooms.forEach(room => {
        const albumArt = room.nowPlaying?.track.albumArt || '/assets/placeholder.svg';
        // NEW HTML structure for the improved room card
        const roomCardHTML = `
        <div class="room-card" data-room-id="${room.id}">
            <img src="${albumArt}" alt="${room.name}" class="album-art"/>
            <div class="room-card-info">
                <h3 class="room-name">${room.name}</h3>
                <div class="room-card-footer">
                    <div class="room-listeners">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        <span>${room.listenerCount} listeners</span>
                    </div>
                    <div class="status-indicator">
                        <div class="status-dot"></div>
                        <span>LIVE</span>
                    </div>
                </div>
            </div>
        </div>`;
        roomsGrid.insertAdjacentHTML('beforeend', roomCardHTML);
    });

    document.querySelectorAll('.room-card').forEach(card => {
        card.addEventListener('click', () => {
            const roomId = card.dataset.roomId;
            window.location.href = `/room/${roomId}`;
        });
    });
});

    // --- THE BIG CHANGE #3: Listen for the server confirming room creation ---
    socket.on('roomCreated', ({ roomId }) => {
        console.log(`Server confirmed room ${roomId} was created. Joining now...`);
        window.location.href = `/room/${roomId}`;
    });
});