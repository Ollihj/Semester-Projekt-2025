// Handle join party form
document.getElementById('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    
    const partyCode = document.getElementById('partyCodeInput').value.trim();
    
    if (partyCode) {
        // Go to party page
        window.location.href = `/party/${partyCode}`;
    }
});

// Handle create party button
document.getElementById('createButton').addEventListener('click', () => {
    // Generate random 4-character party code
    const partyCode = crypto.randomUUID().substring(0, 4);
    
    // Go to new party page
    window.location.href = `/party/${partyCode}`;
});