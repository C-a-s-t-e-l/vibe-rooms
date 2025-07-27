let spotifyPlayer;
const spotifyApi = new SpotifyWebApi();

function initializePlayer(token) {
    if (spotifyPlayer) return;
    console.log("Initializing Spotify Player...");
    spotifyPlayer = new Spotify.Player({
        name: 'Vibe Rooms Player',
        getOAuthToken: cb => { cb(token); }
    });
    spotifyPlayer.addListener('ready', ({ device_id }) => console.log('Player is ready with Device ID', device_id));
    spotifyPlayer.addListener('not_ready', ({ device_id }) => console.log('Device ID has gone offline', device_id));
    spotifyPlayer.addListener('initialization_error', ({ message }) => console.error('Failed to initialize player:', message));
    spotifyPlayer.connect().then(success => {
        if (success) console.log('The Spotify Player connected successfully!');
    });
}

window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('Spotify SDK is ready. Trying to initialize player...');
    const token = spotifyApi.getAccessToken();
    if (token) initializePlayer(token);
};

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Loaded. Vibe Rooms script is running.');
    const socket = io();
    let currentUser;
    let currentRoom;

    // --- DOM Elements ---
    const navActions = document.querySelector('.nav-actions');
    const heroSection = document.querySelector('.hero');
    const roomsSection = document.querySelector('.rooms-section');
    const roomsGrid = document.querySelector('.rooms-grid');

    // --- Handle Authentication ---
    const params = new URLSearchParams(window.location.hash.substring(1));
    const urlToken = params.get('access_token');
    const storedToken = localStorage.getItem('spotifyAccessToken');

    if (urlToken) {
        console.log('SUCCESS: New Access Token found in URL! Storing it.');
        localStorage.setItem('spotifyAccessToken', urlToken);
        spotifyApi.setAccessToken(urlToken);
        setupLoggedInUI(urlToken);
        window.history.pushState({}, document.title, "/");
    } else if (storedToken) {
        console.log('Found stored Access Token. Using it to log in.');
        spotifyApi.setAccessToken(storedToken);
        setupLoggedInUI(storedToken);
    } else {
        console.log('No Access Token found. Waiting for user to sign in.');
    }

    function setupLoggedInUI(token) {
        console.log('Setting up logged-in UI...');
        heroSection.style.display = 'none';
        roomsSection.style.display = 'block';
        navActions.innerHTML = `<p class="nav-link" id="welcome-message">Welcome!</p>`;
        const welcomeMessage = document.getElementById('welcome-message');

        spotifyApi.getMe().then(user => {
            currentUser = user;
            console.log('Logged in as:', currentUser.display_name);
            welcomeMessage.textContent = `Welcome, ${currentUser.display_name}`;
        }).catch(err => {
            console.error('Could not get user profile, token might be expired.', err);
            // If the token is bad, clear it and force a real login
            localStorage.removeItem('spotifyAccessToken');
            window.location.href = '/'; // Go back to the homepage
        });

        if (typeof Spotify !== 'undefined') {
            initializePlayer(token);
        }
        socket.emit('getRooms');
    }

    // --- Helper UI Functions ---
    function updateQueueUI(queue) {
        const queueList = document.getElementById('queue-list');
        if (!queueList) return;
        queueList.innerHTML = '';
        if (!queue || queue.length === 0) {
            queueList.innerHTML = '<p class="system-message">Queue is empty. Add a song!</p>';
            return;
        }
        queue.forEach(track => {
            queueList.innerHTML += `<p>${track.name} - ${track.artist}</p>`;
        });
    }

    function updateNowPlayingUI(nowPlaying) {
        const nowPlayingText = document.getElementById('now-playing-text');
        if (!nowPlayingText) return;
        if (!nowPlaying || !nowPlaying.track) {
            nowPlayingText.textContent = 'Nothing is playing...';
            return;
        }
        nowPlayingText.textContent = `${nowPlaying.track.name} by ${nowPlaying.track.artist}`;
    }

    function displaySearchResults(tracks) {
        const searchResults = document.getElementById('search-results');
        searchResults.innerHTML = '';
        tracks.forEach(track => {
            const resultDiv = document.createElement('div');
            resultDiv.innerHTML = `<strong>${track.name}</strong><br><small>${track.artists[0].name}</small>`;
            resultDiv.style.cursor = 'pointer';
            resultDiv.style.padding = '8px';
            resultDiv.onmouseenter = () => resultDiv.style.backgroundColor = 'hsl(var(--muted))';
            resultDiv.onmouseleave = () => resultDiv.style.backgroundColor = 'transparent';
            resultDiv.onclick = () => {
                socket.emit('addSong', { roomId: currentRoom.id, trackId: track.id });
                searchResults.innerHTML = '';
                document.getElementById('search-input').value = '';
            };
            searchResults.appendChild(resultDiv);
        });
    }

    // --- Socket.IO Event Listeners ---
    socket.on('updateRoomsList', (rooms) => {
        roomsGrid.innerHTML = '';
        if (rooms.length === 0) {
            roomsGrid.innerHTML = '<p style="text-align: center; color: hsl(var(--muted-foreground));">No active vibes... Be the first to start one!</p>';
        }
        rooms.forEach(room => {
            const roomCardHTML = `<div class="room-card" data-room-id="${room.id}"><div class="room-card-content"><div class="album-art-container"><img src="${room.nowPlaying?.track.albumArt || 'assets/placeholder.svg'}" alt="${room.name}" class="album-art"/><div class="play-overlay"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="play-icon"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div></div><div class="room-info"><h3 class="room-name">${room.name}</h3><div class="room-listeners"><span>${room.listenerCount} listeners</span></div></div><div class="status-indicator"><div class="status-dot animate-pulse-glow"></div><span class="status-text">LIVE</span></div></div></div>`;
            roomsGrid.insertAdjacentHTML('beforeend', roomCardHTML);
        });
        document.querySelectorAll('.room-card').forEach(card => {
            card.addEventListener('click', () => {
                const roomId = card.dataset.roomId;
                if(currentUser) socket.emit('joinRoom', { roomId, spotifyUser: currentUser });
            });
        });
        document.getElementById('create-room-btn').onclick = () => {
            if (!currentUser) return alert('Please wait for user info to load.');
            const roomName = prompt("What's the vibe? (Enter a room name)");
            if (roomName && roomName.trim() !== '') socket.emit('createRoom', { roomName, spotifyUser: currentUser });
        };
    });

    socket.on('joinedRoom', (data) => {
        currentRoom = data.room;
        const roomView = document.getElementById('room-view');
        const roomNameDisplay = document.getElementById('room-name-display');
        const leaveRoomBtn = document.getElementById('leave-room-btn');
        const chatMessages = document.getElementById('chat-messages');
        const chatForm = document.getElementById('chat-form');
        const chatInput = document.getElementById('chat-input');
        const searchForm = document.getElementById('search-form');
        const searchInput = document.getElementById('search-input');
        
        roomsSection.style.display = 'none';
        roomView.style.display = 'block';
        roomNameDisplay.textContent = currentRoom.name;
        chatMessages.innerHTML = '<p class="system-message">Welcome to the vibe!</p>';
        
        updateQueueUI(data.queue);
        updateNowPlayingUI(data.nowPlaying);

        chatForm.onsubmit = (e) => {
            e.preventDefault();
            const message = chatInput.value;
            if (message.trim() !== '') {
                socket.emit('sendMessage', { roomId: currentRoom.id, message: message, userName: currentUser.display_name });
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

        leaveRoomBtn.onclick = () => {
            roomView.style.display = 'none';
            roomsSection.style.display = 'block';
            socket.emit('getRooms');
            currentRoom = null;
        };
    });

    socket.on('newChatMessage', (message) => {
        const chatMessages = document.getElementById('chat-messages');
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