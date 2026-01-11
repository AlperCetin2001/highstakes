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

const rooms = new Map();

// --- YARDIMCILAR ---
function generateRoomId() { return Math.random().toString(36).substring(2, 7).toUpperCase(); }
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];
    colors.forEach(color => {
        deck.push({ color, value: '0', type: 'number', score: 0, id: Math.random().toString(36) });
        for (let i = 1; i <= 9; i++) {
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
        }
        ['skip', 'reverse', 'draw2'].forEach(val => {
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
        });
    });
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild', score: 50, id: Math.random().toString(36) });
        deck.push({ color: 'black', value: 'wild4', type: 'wild', score: 50, id: Math.random().toString(36) });
    }
    return shuffle(deck);
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    // ODA LİSTESİ
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, 
            name: r.name, 
            count: r.players.length,
            state: r.gameState 
        }));
        socket.emit('roomList', list);
    });

    // ODA KUR
    socket.on('createRoom', ({ nickname, avatar }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Masası`,
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            timer: null,
            timeLeft: 60
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    // ODAYA GİR
    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    // GEÇ KATILIM ONAYI (HOST'TAN GELEN)
    socket.on('admitPlayer', ({ playerId, decision }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || room.hostId !== socket.id) return;

        const targetPlayer = room.players.find(p => p.id === playerId);
        if(!targetPlayer) return;

        if(decision) {
            // OYUNA DAHİL ET
            targetPlayer.isSpectator = false;
            targetPlayer.hand = [];
            drawCards(room, targetPlayer, 7); // 7 kart ver
            addLog(room, `👋 ${targetPlayer.nickname} oyuna dahil edildi!`);
            broadcastGameState(roomId);
        } else {
            // İZLEYİCİ KAL
            addLog(room, `🚫 ${targetPlayer.nickname} bu el izleyici kalacak.`);
            io.to(targetPlayer.id).emit('notification', { msg: 'Oda sahibi bu ele katılmanı onaylamadı.', type: 'info' });
        }
    });

    // BAŞLAT
    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) return socket.emit('error', 'En az 2 oyuncu gerekli!');

        room.gameState = 'PLAYING';
        room.deck = createDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0;
        room.unoCallers.clear();
        room.logs = [];
        
        // Sadece izleyici olmayanlara kart dağıt
        room.players.forEach(p => {
            if(!p.isSpectator) p.hand = room.deck.splice(0, 7);
        });

        let first;
        do { first = room.deck.pop(); } while (first.color === 'black');
        
        room.discardPile.push(first);
        room.currentColor = first.color;
        
        addLog(room, "Oyun Başladı! Kartlar dağıtıldı.");
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    // ÇOKLU KART OYNAMA (GÜNCELLENDİ)
    socket.on('playCards', ({ cardIndices, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        
        // Kartları al ve doğrula (Büyükten küçüğe sırala ki silerken indeks kaymasın)
        cardIndices.sort((a, b) => b - a);
        const playedCards = cardIndices.map(idx => player.hand[idx]);
        
        // 1. Kart Uygunluğu: Hepsi aynı sayı/değer olmalı
        const firstVal = playedCards[0].value;
        const allSame = playedCards.every(c => c.value === firstVal);
        if(!allSame) return; // Hatalı seçim

        // 2. Masa Uygunluğu: İlk kart masaya uyuyor mu?
        const top = room.discardPile[room.discardPile.length - 1];
        const firstCard = playedCards[0]; // Logic için herhangi biri yeterli
        let matchesTable = (firstCard.color === 'black') || (firstCard.color === room.currentColor) || (firstCard.value === top.value);
        
        if (matchesTable) {
            clearInterval(room.timer);
            
            // Kartları elden çıkar
            cardIndices.forEach(idx => player.hand.splice(idx, 1));
            
            // Masaya ekle (Sırayla)
            playedCards.forEach(c => room.discardPile.push(c));
            
            // Son atılan kartın rengi geçerli olur
            const lastPlayed = playedCards[playedCards.length - 1];
            room.currentColor = (lastPlayed.color === 'black') ? chosenColor : lastPlayed.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            const cardName = playedCards.length > 1 ? `${playedCards.length}x ${firstVal}` : formatCardName(lastPlayed);
            addLog(room, `${player.nickname} attı: ${cardName}`);

            // Efektleri Uygula (Son kartın efekti geçerlidir veya kümülatif olabilir. UNO standartlarında son kartın efekti uygulanır)
            // Ancak çoklu +2 atılırsa kümülatif olsun mu? Orijinalde yok ama online'da zevkli.
            // Biz son kartın efektini uygulayalım, karışıklığı önlemek için.
            handleCardEffect(room, lastPlayed, player);
        }
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (room.players[room.turnIndex].id !== socket.id) return;

        clearInterval(room.timer);
        drawCards(room, room.players[room.turnIndex], 1);
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`);
        advanceTurn(room);
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            io.to(roomId).emit('notification', { msg: `${player.nickname} UNO dedi!`, type: 'warning' });
            io.to(roomId).emit('playSound', 'uno');
            broadcastGameState(roomId);
        }
    });

    socket.on('challengeDecision', ({ decision }) => {
        // ... (Önceki kodun aynısı, Challenge mantığı)
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;
        
        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if(socket.id !== victimId) return;
        
        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);
        
        if(decision === 'accept') {
            addLog(room, `${victim.nickname} kabul etti.`);
            drawCards(room, victim, 4);
        } else {
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if(hasColor) {
                addLog(room, `⚖️ BLÖF YAKALANDI! ${attacker.nickname} ceza çekiyor.`);
                drawCards(room, attacker, 4);
            } else {
                addLog(room, `⚖️ BLÖF DEĞİL! ${victim.nickname} ceza çekiyor.`);
                drawCards(room, victim, 6);
            }
        }
        room.pendingChallenge = null;
        advanceTurn(room);
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) {
                clearInterval(room.timer);
                rooms.delete(roomId);
            } else {
                if(room.hostId === socket.id) room.hostId = room.players[0].id;
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MANTIĞI ---

function startTurnTimer(room) {
    if(room.timer) clearInterval(room.timer);
    room.timeLeft = 60;
    
    room.timer = setInterval(() => {
        room.timeLeft--;
        // Her saniye broadcast yapmak yerine kritik zamanlarda veya client-side tahmin ile yapılabilir.
        // Ama basitlik için her saniye yollayalım (düşük ölçekte sorun olmaz)
        if (room.timeLeft % 5 === 0 || room.timeLeft <= 10) {
             io.to(room.id).emit('timerUpdate', room.timeLeft);
        }

        if(room.timeLeft <= 0) {
            clearInterval(room.timer);
            // Süre doldu: Kart çek ve pas geç
            const player = room.players[room.turnIndex];
            drawCards(room, player, 1);
            addLog(room, `⏰ ${player.nickname} süre aşımı.`);
            advanceTurn(room);
            broadcastGameState(room.id);
            startTurnTimer(room);
        }
    }, 1000);
}

function handleCardEffect(room, card, player) {
    let skipTurn = false;
    if (card.value === 'skip') { skipTurn = true; addLog(room, "Sıra atladı!"); } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        if (room.players.length === 2) skipTurn = true;
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        skipTurn = true;
    }
    else if (card.value === 'wild4') {
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor: room.currentColor };
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        clearInterval(room.timer); // Challenge süresince zamanı durdur
        return; 
    }

    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    advanceTurn(room);
    if (skipTurn) advanceTurn(room);
    broadcastGameState(room.id);
    startTurnTimer(room);
}

function finishGame(room, winner) {
    clearInterval(room.timer);
    let totalScore = 0;
    room.players.forEach(p => { p.hand.forEach(c => totalScore += c.score); });
    
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        score: totalScore,
        players: room.players
    });

    setTimeout(() => {
        room.gameState = 'LOBBY';
        room.players.forEach(p => {
            p.hand = [];
            p.cardCount = 0;
            p.hasUno = false;
            p.isSpectator = false; // Herkes yeni elde oynayabilir
        });
        room.deck = [];
        room.discardPile = [];
        broadcastGameState(room.id);
    }, 8000); // 8 Saniye kutlama süresi
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    
    socket.join(roomId);
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        // Eğer oyun oynanıyorsa SPECTATOR olarak ekle
        const isSpectator = (room.gameState === 'PLAYING');
        room.players.push({ id: socket.id, nickname, avatar, hand: [], isSpectator });
        
        if(isSpectator) {
            io.to(room.id).emit('notification', { msg: `${nickname} izleyici olarak geldi.`, type: 'info' });
            // Host'a sor
            io.to(room.hostId).emit('askHost', { 
                playerId: socket.id, 
                nickname 
            });
        }
    }
    broadcastGameState(roomId);
}

// ... Diğer yardımcı fonksiyonlar (drawCards, advanceTurn vb. - öncekiyle aynı) ...
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
    // Sadece aktif oyuncular arasında dönmeli (Spectator atla)
    // Basitlik için Spectatorlar player listesinde var ama sıraya dahil etmeyeceğiz.
    // Ancak array yapımızda turnIndex var. Spectatorları array sonuna atmalıyız ya da
    // turn logic'inde isSpectator check yapmalıyız.
    // En temizi: filter ile oynayanları bulup index yönetmek ama karmaşık.
    // Basit çözüm: Döngü ile isSpectator olmayan birini bulana kadar ilerle.
    
    let steps = 0;
    do {
        room.turnIndex += room.direction;
        if (room.turnIndex >= room.players.length) room.turnIndex = 0;
        if (room.turnIndex < 0) room.turnIndex = room.players.length - 1;
        steps++;
    } while (room.players[room.turnIndex].isSpectator && steps < room.players.length);
}
function getNextPlayerIndex(room) {
    let idx = room.turnIndex;
    let steps = 0;
    do {
        idx += room.direction;
        if (idx >= room.players.length) idx = 0;
        if (idx < 0) idx = room.players.length - 1;
        steps++;
    } while (room.players[idx].isSpectator && steps < room.players.length);
    return idx;
}
function getNextPlayer(room) { return room.players[getNextPlayerIndex(room)]; }
function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}
function addLog(room, msg) {
    room.logs.push(msg);
    if(room.logs.length > 6) room.logs.shift();
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
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, nickname: pl.nickname, avatar: pl.avatar,
                    cardCount: pl.hand.length, hasUno: room.unoCallers.has(pl.id),
                    isSpectator: pl.isSpectator
                })),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname,
                isMyTurn: room.players[room.turnIndex].id === p.id,
                timer: room.timeLeft
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO ULTIMATE Server Aktif!'));
