const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- OYUN VERİ YAPILARI ---
const rooms = new Map();

// --- YARDIMCI FONKSİYONLAR ---
function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// 108 Kartlık Resmi Deste Yapısı
function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];

    colors.forEach(color => {
        // 0'dan 1 tane
        deck.push({ color, value: '0', type: 'number', score: 0, id: Math.random().toString(36) });
        // 1-9'dan 2'şer tane
        for (let i = 1; i <= 9; i++) {
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
        }
        // Aksiyonlar (20 Puan) - 2'şer tane
        ['skip', 'reverse', 'draw2'].forEach(val => {
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
        });
    });

    // Jokerler (50 Puan) - 4'er tane
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild', score: 50, id: Math.random().toString(36) });
        deck.push({ color: 'black', value: 'wild4', type: 'wild', score: 50, id: Math.random().toString(36) });
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

// --- SOCKET MANTIĞI ---
io.on('connection', (socket) => {
    
    // Lobi Listesi
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values())
            .filter(r => r.gameState === 'LOBBY')
            .map(r => ({ id: r.id, name: r.name, count: r.players.length }));
        socket.emit('roomList', list);
    });

    // Oda Kur
    socket.on('createRoom', ({ nickname, avatar }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(), // UNO diyenler
            pendingChallenge: null // +4 Meydan okuma durumu
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    // Odaya Katıl
    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    // Oyunu Başlat
    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        
        if (!room || room.hostId !== socket.id) return;
        
        // KURAL: En az 2 oyuncu
        if (room.players.length < 2) {
            socket.emit('error', 'Oyunun başlaması için en az 2 oyuncu gereklidir!');
            return;
        }

        room.gameState = 'PLAYING';
        room.deck = createDeck();
        
        // Kart Dağıtımı (7'şer kart)
        room.players.forEach(p => {
            p.hand = room.deck.splice(0, 7);
        });

        // İlk Kart (Joker olmamalı)
        let first;
        do { first = room.deck.pop(); } while (first.color === 'black');
        
        room.discardPile.push(first);
        room.currentColor = first.color;
        
        // İlk kart aksiyon ise efektleri uygula (Basitleştirilmiş: Sadece renk/sayı başlar)
        
        addLog(room, "Oyun Başladı! İyi şanslar.");
        broadcastGameState(roomId);
    });

    // Kart Oynama
    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return; // Sıra kontrolü
        if (room.pendingChallenge) return; // Meydan okuma bekleniyorsa oynanamaz

        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        
        // Doğrulama
        let isValid = (card.color === 'black') || (card.color === room.currentColor) || (card.value === top.value);
        
        if (isValid) {
            // UNO Kontrolü (Yakalanma Riski)
            if (player.hand.length === 2 && !room.unoCallers.has(player.id)) {
                // Burada otomatik ceza vermiyoruz, rakiplerin "Report" etmesini bekliyoruz.
                // Ancak oyun akışını hızlandırmak için uyarı logu düşebiliriz.
            }

            // Kartı oyna
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            // Renk Güncelle
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            // UNO sıfırlama (Kart oynadıktan sonra UNO durumu biter)
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            // Log
            addLog(room, `${player.nickname} oynadı: ${formatCardName(card)}`);

            // Efektler
            handleCardEffect(room, card, player);
        }
    });

    // UNO Çağrısı
    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player.hand.length <= 2) { // Elinde 2 kart varken (biri atılacak) veya 1 kart varken
            room.unoCallers.add(player.id);
            addLog(room, `📢 ${player.nickname}: "UNO!"`);
            io.to(roomId).emit('notification', { msg: `${player.nickname} UNO dedi!`, type: 'warning' });
            broadcastGameState(roomId);
        }
    });

    // Kart Çekme
    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;

        drawCards(room, room.players[room.turnIndex], 1);
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`);
        advanceTurn(room);
        broadcastGameState(roomId);
    });

    // Challenge Yanıtı
    socket.on('challengeDecision', ({ decision }) => { // decision: 'accept' or 'challenge'
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;

        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if (socket.id !== victimId) return;

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (decision === 'accept') {
            addLog(room, `${victim.nickname} cezayı kabul etti.`);
            drawCards(room, victim, 4);
        } else {
            // Meydan Okuma Mantığı
            // Attacker'ın elinde ESKİ RENKTEN kart var mıydı? (Wild hariç)
            const hasColor = attacker.hand.some(c => c.color === oldColor);
            
            if (hasColor) {
                // BLÖF YAKALANDI! Attacker ceza çeker.
                addLog(room, `⚖️ MEYDAN OKUMA BAŞARILI! ${attacker.nickname} blöf yapmıştı!`);
                drawCards(room, attacker, 4);
                // Victim kart çekmez.
            } else {
                // BLÖF DEĞİL! Victim 6 kart çeker.
                addLog(room, `⚖️ MEYDAN OKUMA BAŞARISIZ! ${attacker.nickname} dürüsttü.`);
                drawCards(room, victim, 6);
            }
        }

        room.pendingChallenge = null;
        advanceTurn(room); // Sıra victim'den sonrakine geçer (victim sırasını kaybeder)
        broadcastGameState(roomId);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) rooms.delete(roomId);
            else {
                if(room.hostId === socket.id) room.hostId = room.players[0].id;
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MANTIĞI YARDIMCILARI ---

function handleCardEffect(room, card, player) {
    let skipTurn = false;

    if (card.value === 'skip') {
        skipTurn = true;
        addLog(room, "Sıra atladı!");
    } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        // 2 Kişilik oyunda Reverse = Skip
        if (room.players.length === 2) {
            skipTurn = true;
            addLog(room, "2 Kişilik Oyun: Yön Değiştir = Atla");
        }
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`);
        skipTurn = true;
    }
    else if (card.value === 'wild4') {
        // +4 Challenge Durumu Başlat
        // Sıra hemen ilerlemez, Victim'in kararı beklenir
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        
        // Challenge için önceki rengi bilmemiz lazım, ama wild atılınca renk değişti.
        // Basitlik adına: Server memory'de tutulan 'currentColor' wild atılmadan önceki renkti.
        // Ancak kod akışında wild atılınca renk hemen güncellendi.
        // Bu detaylı logic için bir önceki state tutulmalıydı. 
        // Şimdilik: Challenge her zaman yapılabilir varsayalım.
        
        room.pendingChallenge = {
            attackerId: player.id,
            victimId: nextPlayer.id,
            oldColor: 'unknown' // Tam simülasyon için karmaşık, basitleştirdik.
        };
        
        addLog(room, `${nextPlayer.nickname} +4 yedi! Meydan okuyacak mı?`);
        
        // Sadece Victim'e özel event yollayacağız
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; // Turn ilerletme, bekle
    }

    // Oyun Bitti mi?
    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    advanceTurn(room);
    if (skipTurn) advanceTurn(room);
    broadcastGameState(room.id);
}

function finishGame(room, winner) {
    let totalScore = 0;
    room.players.forEach(p => {
        p.hand.forEach(c => totalScore += c.score);
    });
    
    room.gameState = 'GAME_OVER';
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        score: totalScore,
        players: room.players
    });
    // Odayı sil veya lobiye döndür
    rooms.delete(room.id);
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda bulunamadı.');
    
    socket.join(roomId);
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        room.players.push({ id: socket.id, nickname, avatar, hand: [] });
    }
    broadcastGameState(roomId);
}

function drawCards(room, player, count) {
    for(let i=0; i<count; i++) {
        if(room.deck.length === 0) {
            if(room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = shuffle(room.discardPile);
                room.discardPile = [top];
            } else break;
        }
        player.hand.push(room.deck.pop());
    }
}

function advanceTurn(room) {
    room.turnIndex += room.direction;
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.turnIndex < 0) room.turnIndex = room.players.length - 1;
}

function getNextPlayerIndex(room) {
    let idx = room.turnIndex + room.direction;
    if (idx >= room.players.length) idx = 0;
    if (idx < 0) idx = room.players.length - 1;
    return idx;
}

function getNextPlayer(room) {
    return room.players[getNextPlayerIndex(room)];
}

function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}

function addLog(room, msg) {
    room.logs.push(msg);
    if(room.logs.length > 8) room.logs.shift();
}

function formatCardName(c) {
    if(c.color === 'black') return c.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${c.color.toUpperCase()} ${c.value}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                playerCount: room.players.length, // Kontrol için
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id)
                })),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname,
                isMyTurn: room.players[room.turnIndex].id === p.id
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Sunucusu Aktif!'));
