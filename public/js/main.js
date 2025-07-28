// public/js/main.js (Corrected Version - Redundant Player Initialization Removed)

// This API object is still needed to get the user's profile.
const spotifyApi = new SpotifyWebApi();

// --- REMOVED ---
// We no longer need a global spotifyPlayer variable in the lobby.
// We no longer need an initializePlayer function here.
// We no longer need the window.onSpotifyWebPlaybackSDKReady function here.
// This prevents the conflict with the real player in room.js.

document.addEventListener('DOMContentLoaded', () => {
    console.log('Lobby script loaded.');
    const socket = io();
    let currentUser;

    const navActions = document.querySelector('.nav-actions');
    const heroSection = document.querySelector('.hero');
    const roomsSection = document.querySelector('.rooms-section');
    const roomsGrid = document.querySelector('.rooms-grid');
    const createRoomBtn = document.getElementById('create-room-btn');


    const urlToken = new URLSearchParams(window.location.hash.substring(1)).get('access_token');
    const storedToken = localStorage.getItem('spotifyAccessToken');
    const tokenToUse = urlToken || storedToken;

    if (urlToken) {
        localStorage.setItem('spotifyAccessToken', urlToken);
        window.history.pushState({}, document.title, "/");
    }

    if (tokenToUse) {
        spotifyApi.setAccessToken(tokenToUse);
        setupLoggedInUI(); // We don't need to pass the token here anymore
    }

    if (createRoomBtn) {
        createRoomBtn.addEventListener('click', () => {
            if (!currentUser) {
                alert("Could not get your Spotify profile. Please wait a moment or try logging in again.");
                return;
            }

            const roomName = prompt("Enter a name for your new Vibe Room:");
            
            if (roomName && roomName.trim() !== "") {
                console.log(`Attempting to create room: '${roomName.trim()}'`);
                socket.emit('createRoom', { roomName: roomName.trim(), spotifyUser: currentUser });
            }
        });
    }

    function setupLoggedInUI() {
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

        // The player initialization logic has been completely removed from here.
        socket.emit('getRooms');
    }

    socket.on('updateRoomsList', (rooms) => {
        if (!roomsGrid) return; // Defensive check
        
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