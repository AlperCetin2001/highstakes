const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // InfinityFree domaininiz buraya gelecek, şimdilik * (herkes)
        methods: ["GET", "POST"]
    }
});

const rooms = {};

// UNO Kart Destesi Oluşturma
function createDeck() {
    const colors = ['red', 'yellow', 'green', 'blue'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    const deck = [];

    colors.forEach(color => {
        values.forEach(value => {
            deck.push({ color, value, type: 'normal' });
            if (value !== '0') deck.push({ color, value, type: 'normal' });
        });
    });

    // Wild kartlar (basitlik için 4'er tane)
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild' });
        deck.push({ color: 'black', value: 'draw4', type: 'wild' });
    }

    return shuffle(deck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

io.on('connection', (socket) => {
    console.log('Bir kullanıcı bağlandı:', socket.id);

    // Oda Oluşturma / Katılma
    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: [],
                discardPile: [],
                turnIndex: 0,
                direction: 1, // 1: Saat yönü, -1: Ters
                gameStarted: false
            };
        }

        const room = rooms[roomId];

        if (room.gameStarted) {
            socket.emit('error', 'Oyun çoktan başladı!');
            return;
        }

        room.players.push({ id: socket.id, hand: [] });
        socket.join(roomId);

        io.to(roomId).emit('playerJoined', room.players.length);
        
        // İlk oyuncu odayı başlatan (host) olsun
        if (room.players.length === 1) {
            socket.emit('isHost', true);
        }
    });

    // Oyunu Başlatma
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players.length < 2) return; // En az 2 kişi lazım

        room.gameStarted = true;
        room.deck = createDeck();
        
        // Herkese 7 kart dağıt
        room.players.forEach(player => {
            player.hand = room.deck.splice(0, 7);
        });

        // Ortaya bir kart aç
        let startCard = room.deck.pop();
        while(startCard.color === 'black') { // İlk kart renkli olmalı
            room.deck.unshift(startCard);
            startCard = room.deck.pop();
        }
        room.discardPile.push(startCard);

        updateGameState(roomId);
    });

    // Kart Oynama
    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        const playerIndex = room.players.indexOf(player);

        // Sıra bu oyuncuda mı?
        if (playerIndex !== room.turnIndex) return;

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];

        // Hamle geçerli mi?
        let isValid = false;
        if (card.color === 'black') isValid = true; // Wild kartlar her zaman oynanır
        else if (card.color === topCard.color || card.value === topCard.value) isValid = true;
        
        // Eğer önceki kart Wild ise ve renk seçilmişse kontrol et
        if (topCard.color === 'black' && topCard.chosenColor && card.color === topCard.chosenColor) isValid = true;

        if (isValid) {
            // Kartı elden çıkar, ortaya koy
            player.hand.splice(cardIndex, 1);
            
            if (card.color === 'black') {
                card.chosenColor = chosenColor || 'red'; // Default red, frontend'den gelmeli
                // Görsel hile: Ortadaki kartın rengini seçilen renk yapıyoruz mantıken
                card.displayColor = chosenColor; 
            }

            room.discardPile.push(card);

            // Özel Kart Etkileri
            if (card.value === 'skip') {
                room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
            } else if (card.value === 'reverse') {
                room.direction *= -1;
                if(room.players.length === 2) { // 2 kişide reverse skip gibi davranır
                     room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
                }
            } else if (card.value === 'draw2') {
                const nextPlayerIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
                room.players[nextPlayerIndex].hand.push(...room.deck.splice(0, 2));
            } else if (card.value === 'draw4') {
                const nextPlayerIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
                room.players[nextPlayerIndex].hand.push(...room.deck.splice(0, 4));
            }

            // Oyun Bitti mi?
            if (player.hand.length === 0) {
                io.to(roomId).emit('gameOver', socket.id);
                delete rooms[roomId];
                return;
            }

            // Sırayı geçir
            room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
            updateGameState(roomId);
        }
    });

    // Kart Çekme
    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.turnIndex) return;

        if (room.deck.length === 0) {
            // Deste biterse yerdeki kartları karıştırıp desteye koy (en üstteki hariç)
            const topCard = room.discardPile.pop();
            room.deck = shuffle(room.discardPile);
            room.discardPile = [topCard];
        }

        player.hand.push(room.deck.pop());
        // Kart çektikten sonra sıra geçer (basit kural)
        // room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length; 
        // Not: Orijinal Uno'da çektiğin kart oynanabilirse oynarsın, biz şimdilik sadece çektirip update atalım, oyuncu oynayabilir veya pas geçebilir.
        
        updateGameState(roomId);
    });

    socket.on('disconnect', () => {
        console.log('Kullanıcı ayrıldı:', socket.id);
        // Basitlik için odadan düşeni silmiyoruz, oyun kilitlenebilir. 
        // Gelişmiş versiyonda odayı temizlemek gerekir.
    });
});

function updateGameState(roomId) {
    const room = rooms[roomId];
    
    // Her oyuncuya sadece kendi elini ve genel oyun durumunu gönder (hile koruması)
    room.players.forEach((player, index) => {
        const gameState = {
            hand: player.hand,
            topCard: room.discardPile[room.discardPile.length - 1],
            isMyTurn: index === room.turnIndex,
            opponentCardCounts: room.players.map(p => p.hand.length), // Rakiplerin kart sayısı
            turnIndex: room.turnIndex
        };
        io.to(player.id).emit('gameState', gameState);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
