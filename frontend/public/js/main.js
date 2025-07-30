// public/js/main.js

document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // --- Core DOM Elements ---
    const navActions = document.querySelector('.nav-actions');
    const loggedOutView = document.getElementById('logged-out-view');
    const loggedInView = document.getElementById('logged-in-view');
    const roomsGrid = document.querySelector('.rooms-grid');
    const noRoomsMessage = document.getElementById('no-rooms-message');
    
    // This is the trigger button in the main view
    const createRoomBtn = document.getElementById('create-room-btn');

    // --- Create Room Modal Elements ---
    const modalOverlay = document.getElementById('create-room-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const roomNameInput = document.getElementById('room-name-input');
    const presetVibesContainer = document.getElementById('preset-vibes-container');
    const presetVibeBtns = presetVibesContainer.querySelectorAll('.vibe-tag');
    const customVibeInput = document.getElementById('custom-vibe-input');
    const modalCreateBtn = document.getElementById('modal-create-btn');

    let selectedVibe = null; // State to hold the chosen vibe

    // --- Check Authentication Status on Page Load ---
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

    /**
     * Sets up the UI and event listeners for a logged-in user.
     * @param {object} user - The user object from the server.
     */
    function setupLoggedInUI(user) {
        loggedOutView.style.display = 'none';
        loggedInView.style.display = 'block';

        // Update navigation with user info and logout button
        navActions.innerHTML = `
            <p class="nav-link">Welcome, ${user.displayName}!</p>
            <a href="/logout" class="btn btn-secondary">Log Out</a>
        `;

        // --- All Modal Logic and Event Listeners ---
        
        // Helper functions to show/hide the modal
        function showModal() {
            modalOverlay.style.display = 'flex';
            setTimeout(() => modalOverlay.classList.add('visible'), 10); // For fade-in transition
        }

        function hideModal() {
            modalOverlay.classList.remove('visible');
            // Reset form after transition ends
            setTimeout(() => {
                modalOverlay.style.display = 'none';
                roomNameInput.value = '';
                customVibeInput.value = '';
                presetVibeBtns.forEach(btn => btn.classList.remove('active'));
                selectedVibe = null;
            }, 300);
        }

        // Main button to open the modal
        createRoomBtn.addEventListener('click', showModal);

        // Buttons and actions to close the modal
        closeModalBtn.addEventListener('click', hideModal);
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                hideModal();
            }
        });

        // Handle selection of a preset vibe
        presetVibeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                presetVibeBtns.forEach(otherBtn => otherBtn.classList.remove('active'));
                customVibeInput.value = ''; // Clear custom input
                btn.classList.add('active');
                selectedVibe = {
                    name: btn.dataset.vibeName,
                    type: 'PRESET'
                };
            });
        });

        // Handle typing of a custom vibe
        customVibeInput.addEventListener('input', () => {
            if (customVibeInput.value.trim() !== '') {
                presetVibeBtns.forEach(btn => btn.classList.remove('active')); // Clear preset selection
                selectedVibe = {
                    name: customVibeInput.value.trim(),
                    type: 'CUSTOM'
                };
            } else {
                selectedVibe = null;
            }
        });

        // Handle the final "Create Room" click
        modalCreateBtn.addEventListener('click', () => {
            const roomName = roomNameInput.value.trim();
            
            if (!roomName) {
                alert('Please enter a room name.');
                return;
            }
            if (!selectedVibe || !selectedVibe.name) {
                alert('Please select a preset vibe or create a custom one.');
                return;
            }

            const roomData = {
                roomName: roomName,
                vibe: selectedVibe
            };
            
            // Send the structured data object to the server
            socket.emit('createRoom', roomData);
            
            hideModal();
        });

        // --- Socket Listeners for the Lobby ---
        socket.on('updateRoomsList', updateRoomsList);
        socket.on('roomCreated', ({ roomId }) => {
            // Redirect user to the new room they just created
            window.location.href = `/room/${roomId}`;
        });

        // Initial fetch of rooms when user lands on the page
        socket.emit('getRooms');
    }

    /**
     * Renders the list of rooms in the grid.
     * @param {Array} rooms - An array of room objects from the server.
     */
   let allRooms = [];
let currentFilter = 'All'; // 'All' by default

// Find your socket listener for the lobby data
// REPLACE your old 'updateRoomsList' listener with this new 'updateLobby' one.
socket.on('updateLobby', ({ rooms, vibes }) => {
  allRooms = rooms; // Store the master list of rooms
  renderVibeTags(vibes);
  renderFilteredRooms(); // Render rooms based on the current filter
});

function renderVibeTags(vibes) {
  const container = document.getElementById('vibe-tag-cloud');
  if (!container) return;

  container.innerHTML = ''; // Clear old tags

  // "All" button
  const allBtn = document.createElement('button');
  allBtn.className = 'vibe-tag';
  allBtn.textContent = 'All';
  allBtn.dataset.vibeName = 'All';
  if (currentFilter === 'All') {
    allBtn.classList.add('active');
  }
  allBtn.addEventListener('click', () => setFilter('All'));
  container.appendChild(allBtn);

  // Vibe tags from the server
  vibes.forEach(vibe => {
    if (vibe.count > 0 || vibe.type === 'PRESET') {
      const tagBtn = document.createElement('button');
      tagBtn.className = 'vibe-tag';
      tagBtn.dataset.vibeName = vibe.name;
      tagBtn.innerHTML = `${vibe.name} <span class="tag-count">(${vibe.count})</span>`;
      
      if (currentFilter === vibe.name) {
        tagBtn.classList.add('active');
      }

      tagBtn.addEventListener('click', () => setFilter(vibe.name));
      container.appendChild(tagBtn);
    }
  });
}

function setFilter(vibeName) {
  currentFilter = vibeName;
  // Re-render both tags (to update the .active class) and rooms
  const container = document.getElementById('vibe-tag-cloud');
  container.querySelectorAll('.vibe-tag').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vibeName === vibeName);
  });
  renderFilteredRooms();
}

function renderFilteredRooms() {
  let roomsToRender = allRooms;
  if (currentFilter !== 'All') {
    // This assumes your getPublicRoomsData() function adds the vibe name to the room object!
    // We need to update that on the backend.
    roomsToRender = allRooms.filter(room => room.vibe && room.vibe.name === currentFilter);
  }
  updateRoomsList(roomsToRender); // Call your existing function to render the cards
}   
});