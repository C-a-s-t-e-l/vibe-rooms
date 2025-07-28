// public/js/main.js (Final, Bulletproof Version)

const spotifyApi = new SpotifyWebApi();

// This empty function is required by the Spotify SDK on any page it's loaded.
window.onSpotifyWebPlaybackSDKReady = () => {
    console.log("Spotify SDK is ready on the lobby page (no player needed).");
};

document.addEventListener('DOMContentLoaded', () => {
    console.log('Lobby script loaded.');
    const socket = io();
    
    // --- DOM Elements ---
    const navActions = document.querySelector('.nav-actions');
    const heroSection = document.querySelector('.hero');
    const roomsSection = document.querySelector('.rooms-section');
    const roomsGrid = document.querySelector('.rooms-grid');
    const createRoomBtn = document.getElementById('create-room-btn');

    // --- Core Authentication Logic ---
    const urlToken = new URLSearchParams(window.location.hash.substring(1)).get('access_token');
    const storedToken = localStorage.getItem('spotifyAccessToken');

    if (urlToken) {
        localStorage.setItem('spotifyAccessToken', urlToken);
        // Clean the URL and reload to ensure a clean state
        window.history.pushState({}, document.title, "/");
        validateTokenAndSetupUI(urlToken);
    } else if (storedToken) {
        validateTokenAndSetupUI(storedToken);
    }

    /**
     * The most robust way to check if a token is valid.
     * Bypasses library state issues by calling the Spotify API directly.
     */
    function validateTokenAndSetupUI(token) {
        fetch('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(res => {
            if (!res.ok) {
                // If the response is not 200 OK, the token is invalid.
                throw new Error('Invalid token');
            }
            return res.json();
        })
        .then(user => {
            // SUCCESS: The token is valid and we have the user data.
            // Now it's safe to set the token for the library for any future use.
            spotifyApi.setAccessToken(token);
            showLobbyView(user);
        })
        .catch(() => {
            // FAILURE: The token is bad. Log the user out.
            logout();
        });
    }

    /**
     * Renders the logged-in view with rooms, welcome message, etc.
     */
    function showLobbyView(user) {
        heroSection.style.display = 'none';
        roomsSection.style.display = 'block';

        navActions.innerHTML = `
            <p class="nav-link" id="welcome-message">Welcome, ${user.display_name}!</p>
            <button id="logout-btn" class="btn btn-secondary">Log Out</button>
        `;

        document.getElementById('logout-btn').addEventListener('click', logout);

        createRoomBtn.addEventListener('click', () => {
            const roomName = prompt("Enter a name for your new Vibe Room:");
            if (roomName && roomName.trim() !== "") {
                socket.emit('createRoom', { roomName: roomName.trim(), spotifyUser: user });
            }
        });

        // Fetch the initial list of rooms
        socket.emit('getRooms');
    }

    /**
     * Clears user session data and returns to the login page.
     */
    function logout() {
        localStorage.removeItem('spotifyAccessToken');
        window.location.href = '/';
    }


    // --- Socket.IO Event Handlers ---
    socket.on('updateRoomsList', (rooms) => {
        if (!roomsGrid) return;
        
        roomsGrid.innerHTML = '';
        if (rooms.length === 0) {
            roomsGrid.innerHTML = '<p style="text-align: center; color: hsl(var(--muted-foreground));">No active vibes... Be the first to start one!</p>';
            return;
        }

        rooms.forEach(room => {
            const roomCard = document.createElement('div');
            roomCard.className = 'room-card';
            roomCard.dataset.roomId = room.id;
            const albumArtUrl = room.nowPlaying ? room.nowPlaying.track.albumArt : '/assets/placeholder.svg';
            if (room.nowPlaying) {
                roomCard.style.backgroundImage = `url(${albumArtUrl})`;
            }
            roomCard.innerHTML = `
                <img src="${albumArtUrl}" alt="${room.name}" class="album-art"/>
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
            `;
            roomCard.addEventListener('click', () => {
                window.location.href = `/room/${room.id}`;
            });
            roomsGrid.appendChild(roomCard);
        });
    });

    socket.on('roomCreated', ({ roomId }) => {
        console.log(`Server confirmed room ${roomId} was created. Joining now...`);
        window.location.href = `/room/${roomId}`;
    });
});