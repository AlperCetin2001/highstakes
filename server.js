const colyseus = require("colyseus");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Schema, MapSchema, ArraySchema, type } = require("@colyseus/schema");

// --- VERİ YAPILARI ---
class Card extends Schema {
    constructor(color, value, type) {
        super();
        this.color = color; // red, blue, green, yellow, black
        this.value = value; // 0-9, or +2, skip, reverse, wild
        this.type = type;   // number, action
    }
}
type("string")(Card.prototype, "color");
type("string")(Card.prototype, "value");
type("string")(Card.prototype, "type");

class Player extends Schema {
    constructor(name, sessionId) {
        super();
        this.id = sessionId;
        this.name = name;
        this.hand = new ArraySchema();
        this.isAlive = true;
        this.isSafe = false; // Uno dedi mi?
    }
}
type("string")(Player.prototype, "id");
type("string")(Player.prototype, "name");
type([ Card ])(Player.prototype, "hand");
type("boolean")(Player.prototype, "isAlive");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.currentTurn = "";
        this.direction = 1;
        this.topCard = new Card("black", "start", "action");
        this.gameStatus = "LOBBY"; // LOBBY, GAME, ROULETTE
        this.activeColor = ""; 
        this.deck = [];
        this.playerIds = new ArraySchema();
        this.turnIndex = 0;
    }
}
type({ map: Player })(GameState.prototype, "players");
type("string")(GameState.prototype, "currentTurn");
type(Card)(GameState.prototype, "topCard");
type("string")(GameState.prototype, "activeColor");
type("string")(GameState.prototype, "gameStatus");

// --- OYUN MANTIĞI ---
class HighStakesRoom extends colyseus.Room {
    
    onCreate(options) {
        this.setState(new GameState());
        this.roomId = this.generateRoomId();
        console.log("Masa Kuruldu:", this.roomId);

        // OYUNU BAŞLAT
        this.onMessage("start_game", (client) => {
            if (this.state.players.size < 2) return; // Tek başına oynanmaz
            this.setupDeck();
            this.dealCards();
            this.state.gameStatus = "GAME";
            this.state.turnIndex = 0;
            this.state.currentTurn = this.state.playerIds[0];
            
            // İlk kartı aç (Sayı kartı gelene kadar)
            let startCard = this.drawCardFromDeck();
            while(startCard.color === "black") { // Joker gelirse tekrar çek
                this.deck.push(startCard); 
                startCard = this.drawCardFromDeck();
            }
            this.state.topCard = startCard;
            this.state.activeColor = startCard.color;
            this.broadcast("notification", "OYUN BAŞLADI. İLK KART: " + startCard.color.toUpperCase() + " " + startCard.value);
        });

        // KART OYNAMA
        this.onMessage("play_card", (client, message) => {
            if (this.state.currentTurn !== client.sessionId) return;
            const player = this.state.players.get(client.sessionId);
            const cardIndex = message.index;
            const card = player.hand[cardIndex];

            // Kural Kontrolü
            if (this.isValidMove(card)) {
                // Kartı elden çıkar
                player.hand.splice(cardIndex, 1);
                this.state.topCard = card;
                
                // Renk ayarla (Jokerse gelen veri, değilse kartın rengi)
                if (card.color === "black") {
                    this.state.activeColor = message.color || "red"; // Seçilen renk
                } else {
                    this.state.activeColor = card.color;
                }

                // Efektleri Uygula
                this.applyCardEffect(card);

                // Uno Kontrolü
                if (player.hand.length === 0) {
                    this.broadcast("notification", `${player.name} KAZANDI!`);
                    this.state.gameStatus = "LOBBY";
                } else {
                    this.nextTurn();
                }
            }
        });

        // KART ÇEKME
        this.onMessage("draw_card", (client) => {
            if (this.state.currentTurn !== client.sessionId) return;
            const player = this.state.players.get(client.sessionId);
            
            const newCard = this.drawCardFromDeck();
            player.hand.push(newCard);
            this.broadcast("notification", `${player.name} kart çekti.`);

            // OVERLOAD KONTROLÜ (7 Kart Limiti)
            if (player.hand.length > 7) {
                this.triggerRoulette(player);
            } else {
                this.nextTurn();
            }
        });

        // RULET SONUCU
        this.onMessage("roulette_result", (client, result) => {
            // result: true (yaşadı), false (öldü)
            const player = this.state.players.get(client.sessionId);
            if (result === "survived") {
                this.broadcast("notification", `${player.name} TETİĞİ ÇEKTİ... BOŞ! (Kartlar Sıfırlandı)`);
                player.hand.length = 0; // Kartları sıfırla
                // Cezalı olarak 2 kartla başla
                player.hand.push(this.drawCardFromDeck());
                player.hand.push(this.drawCardFromDeck());
                this.state.gameStatus = "GAME";
                this.nextTurn();
            } else {
                this.broadcast("notification", `${player.name} ELENDİ. (BANG)`);
                player.isAlive = false;
                this.state.gameStatus = "GAME";
                this.nextTurn();
            }
        });
    }

    onJoin(client, options) {
        const player = new Player(options.name || "Drifter", client.sessionId);
        this.state.players.set(client.sessionId, player);
        this.state.playerIds.push(client.sessionId);
        console.log(options.name, "katıldı.");
    }

    onLeave(client) {
        this.state.players.delete(client.sessionId);
        const idx = this.state.playerIds.indexOf(client.sessionId);
        if(idx > -1) this.state.playerIds.splice(idx, 1);
    }

    // --- YARDIMCI FONKSİYONLAR ---
    setupDeck() {
        this.deck = [];
        const colors = ["red", "blue", "green", "yellow"];
        const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "+2"];
        
        colors.forEach(c => {
            values.forEach(v => {
                this.deck.push(new Card(c, v, isNaN(v) ? "action" : "number"));
                if(v !== "0") this.deck.push(new Card(c, v, isNaN(v) ? "action" : "number")); // 0 hariç her karttan 2 tane
            });
        });
        // Jokerler
        for(let i=0; i<4; i++) {
            this.deck.push(new Card("black", "wild", "action"));
            this.deck.push(new Card("black", "+4", "action"));
        }
        this.shuffleDeck();
    }

    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    drawCardFromDeck() {
        if (this.deck.length === 0) this.setupDeck(); // Deste biterse karıştır
        return this.deck.pop();
    }

    dealCards() {
        this.state.players.forEach(player => {
            player.hand.length = 0;
            for(let i=0; i<5; i++) player.hand.push(this.drawCardFromDeck());
        });
    }

    isValidMove(card) {
        // Joker her zaman oynanır
        if (card.color === "black") return true;
        // Renk tutuyor mu?
        if (card.color === this.state.activeColor) return true;
        // Sayı/Değer tutuyor mu?
        if (card.value === this.state.topCard.value) return true;
        return false;
    }

    applyCardEffect(card) {
        if (card.value === "skip") {
            this.state.turnIndex = (this.state.turnIndex + this.state.direction) % this.state.playerIds.length;
        } 
        else if (card.value === "reverse") {
            this.state.direction *= -1;
            // 2 kişiyse skip gibi davranır
            if (this.state.playerIds.length === 2) this.state.turnIndex = (this.state.turnIndex + 1) % 2;
        }
        else if (card.value === "+2") {
            const nextPlayerId = this.getNextPlayerId();
            const nextPlayer = this.state.players.get(nextPlayerId);
            nextPlayer.hand.push(this.drawCardFromDeck());
            nextPlayer.hand.push(this.drawCardFromDeck());
        }
        else if (card.value === "+4") {
            const nextPlayerId = this.getNextPlayerId();
            const nextPlayer = this.state.players.get(nextPlayerId);
            for(let i=0; i<4; i++) nextPlayer.hand.push(this.drawCardFromDeck());
        }
    }

    nextTurn() {
        // Sıradaki oyuncuyu bul (Ölüleri atla)
        let attempts = 0;
        do {
            this.state.turnIndex = (this.state.turnIndex + this.state.direction + this.state.playerIds.length) % this.state.playerIds.length;
            this.state.currentTurn = this.state.playerIds[this.state.turnIndex];
            attempts++;
        } while (!this.state.players.get(this.state.currentTurn).isAlive && attempts < 10);
    }

    getNextPlayerId() {
        let idx = (this.state.turnIndex + this.state.direction + this.state.playerIds.length) % this.state.playerIds.length;
        return this.state.playerIds[idx];
    }

    triggerRoulette(player) {
        this.state.gameStatus = "ROULETTE";
        this.broadcast("notification", `⚠️ AŞIRI YÜKLEME! ${player.name} RULET MASASINDA!`);
        // İstemciye rulet ekranını açması için state değişimi yeterli
    }

    generateRoomId() {
        const chars = "ACDEFGHJKLMNPRTXYZ2345679";
        let result = "";
        for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
        return result;
    }
}

const app = express();
app.use(cors());
const gameServer = new colyseus.Server({ server: http.createServer(app) });
gameServer.define("high_stakes_room", HighStakesRoom);
const port = process.env.PORT || 2567;
gameServer.listen(port);
