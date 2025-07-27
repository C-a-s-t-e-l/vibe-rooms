document.addEventListener('DOMContentLoaded', () => {
  // Function to add a click listener to a button
  const addClickListener = (id, message) => {
    const button = document.getElementById(id);
    if (button) {
      button.addEventListener('click', () => {
        alert(message);
      });
    }
  };

  // Add listeners to all major buttons
  addClickListener('signin-btn', 'Sign In functionality is not yet implemented.');
  addClickListener('join-room-btn', 'Joining a random room! (This is a demo)');
  addClickListener('create-room-btn', 'Create Room functionality coming soon!');

  // Add listeners to room cards for a more interactive feel
  const roomCards = document.querySelectorAll('.room-card');
  roomCards.forEach(card => {
    card.addEventListener('click', () => {
      const roomName = card.querySelector('.room-name').textContent;
      alert(`Entering "${roomName}"... (This is a demo)`);
    });
  });

  // Add listeners to footer links
  const footerLinks = document.querySelectorAll('.footer-link');
  footerLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        alert(`Navigating to ${link.textContent} page... (This is a demo)`);
    });
  });
});