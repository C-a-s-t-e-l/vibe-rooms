// public/js/main.js (Now with Google Auth UI)

document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    
    // --- DOM Elements ---
    const navActions = document.querySelector('.nav-actions');
    const loggedOutView = document.getElementById('logged-out-view');
    const loggedInView = document.getElementById('logged-in-view');
    const roomsGrid = document.querySelector('.rooms-grid');
    const createRoomBtn = document.getElementById('create-room-btn');
    const noRoomsMessage = document.getElementById('no-rooms-message');

    // --- Check Authentication Status ---
    fetch('/api/user')
        .then(res => res.json())
        .then(user => {
            if (user && user.id) {
                // User is logged in
                setupLoggedInUI(user);
            } else {
                // User is not logged in
                loggedOutView.style.display = 'block';
                loggedInView.style.display = 'none';
            }
        })
        .catch(() => {
            // Error or not logged in
            loggedOutView.style.display = 'block';
            loggedInView.style.display = 'none';
        });

    function setupLoggedInUI(user) {
        loggedOutView.style.display = 'none';
        loggedInView.style.display = 'block';

        navActions.innerHTML = `
            <p class="nav-link">Welcome, ${user.displayName}!</p>
            <a href="/logout" class="btn btn-secondary">Log Out</a>
        `;

        createRoomBtn.addEventListener('click', () => {
            const roomName = prompt("Enter a name for your new Vibe Room:");
            if (roomName && roomName.trim() !== "") {
                socket.emit('createRoom', roomName.trim());
            }
        });

        socket.on('updateRoomsList', updateRoomsList);
        socket.on('roomCreated', ({ roomId }) => {
            window.location.href = `/room/${roomId}`;
        });

        socket.emit('getRooms');
    }

    function updateRoomsList(rooms) {
    if (!roomsGrid) return;
    
    roomsGrid.innerHTML = '';
    if (rooms.length === 0) {
        noRoomsMessage.style.display = 'block';
    } else {
        noRoomsMessage.style.display = 'none';
        rooms.forEach(room => {
            const roomCard = document.createElement('div');
            roomCard.className = 'room-card';
            
            // THIS IS THE FIX: Check for nowPlaying AND nowPlaying.track
            const albumArtUrl = (room.nowPlaying && room.nowPlaying.track) ? room.nowPlaying.track.albumArt : '/assets/placeholder.svg';

            if (room.nowPlaying && room.nowPlaying.track) {
                roomCard.style.backgroundImage = `url(${albumArtUrl})`;
            }

            roomCard.innerHTML = `
                <!-- Use the same corrected URL for the img tag -->
                <img src="${albumArtUrl}" alt="${room.name}" class="album-art"/>
                <div class="room-card-info">
                    <h3 class="room-name">${room.name}</h3>
                    <div class="room-card-footer">
                        <div class="room-listeners">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                            <span>${room.listenerCount} listeners</span>
                        </div>
                        <div class="status-indicator">
                            <div class="status-dot"></div><span>LIVE</span>
                        </div>
                    </div>
                </div>
            `;
            roomCard.addEventListener('click', () => {
                window.location.href = `/room/${room.id}`;
            });
            roomsGrid.appendChild(roomCard);
        });
    }
}
});