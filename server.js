const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

const rooms = {};

function generateCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function createDeck() {
  const deck = [];
  const suits = ['oros', 'copas', 'espadas', 'bastos'];
  for (const suit of suits) {
    for (let v = 1; v <= 12; v++) {
      deck.push({ value: v, suit });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealCards(room) {
  const deck = createDeck();
  const n = room.cardsThisRound;
  room.players.forEach(p => {
    p.hand = deck.splice(0, n);
    p.bet = null;
    p.tricksTaken = 0;
    p.eliminated = p.eliminated || false;
  });
  room.deck = deck;
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.eliminated);
}

function getRoundCards(roundIndex) {
  const sequence = [6, 5, 4, 3, 2, 1];
  return sequence[roundIndex % sequence.length];
}

function nextDealerIndex(room) {
  const active = getActivePlayers(room);
  const currentIdx = active.findIndex(p => p.id === room.dealerId);
  return active[(currentIdx + 1) % active.length].id;
}

function getBetOrder(room) {
  const active = getActivePlayers(room);
  const dealerIdx = active.findIndex(p => p.id === room.dealerId);
  const order = [];
  for (let i = 1; i <= active.length; i++) {
    const idx = (dealerIdx - i + active.length) % active.length;
    order.push(active[idx].id);
  }
  return order;
}

function getForbiddenBet(room) {
  const active = getActivePlayers(room);
  const betOrder = room.betOrder;
  const betsPlaced = betOrder.filter(id => {
    const p = room.players.find(pl => pl.id === id);
    return p && p.bet !== null;
  });
  if (betsPlaced.length === active.length - 1) {
    const sumSoFar = betsPlaced.reduce((acc, id) => {
      const p = room.players.find(pl => pl.id === id);
      return acc + (p ? p.bet : 0);
    }, 0);
    return room.cardsThisRound - sumSoFar;
  }
  return null;
}

function startRound(room) {
  room.phase = 'betting';
  room.currentHandIndex = 0;
  room.handCards = [];
  room.lastHandCards = [];
  room.betOrder = getBetOrder(room);
  room.currentBetPlayerIndex = 0;
  dealCards(room);
  broadcastState(room);
  startBetTimer(room);
}

function startBetTimer(room) {
  clearTimeout(room.timer);
  room.timerEndsAt = Date.now() + 30000;
  room.timer = setTimeout(() => {
    const currentBettorId = room.betOrder[room.currentBetPlayerIndex];
    const player = room.players.find(p => p.id === currentBettorId);
    if (player && player.bet === null) {
      const forbidden = getForbiddenBet(room);
      player.bet = (forbidden === 0) ? 1 : 0;
      advanceBetting(room);
    }
  }, 30000);
}

function advanceBetting(room) {
  room.currentBetPlayerIndex++;
  if (room.currentBetPlayerIndex >= room.betOrder.length) {
    room.phase = 'playing';
    room.currentTurnOrder = getTurnOrder(room);
    room.currentTurnIndex = 0;
    broadcastState(room);
    startPlayTimer(room);
  } else {
    broadcastState(room);
    startBetTimer(room);
  }
}

function getTurnOrder(room) {
  const active = getActivePlayers(room);
  const dealerIdx = active.findIndex(p => p.id === room.dealerId);
  const order = [];
  for (let i = 1; i <= active.length; i++) {
    const idx = (dealerIdx - i + active.length) % active.length;
    order.push(active[idx].id);
  }
  return order;
}

function startPlayTimer(room) {
  clearTimeout(room.timer);
  room.timerEndsAt = Date.now() + 30000;
  room.timer = setTimeout(() => {
    const currentPlayerId = room.currentTurnOrder[room.currentTurnIndex];
    const player = room.players.find(p => p.id === currentPlayerId);
    if (player && player.hand.length > 0) {
      const randomCard = player.hand[Math.floor(Math.random() * player.hand.length)];
      playCard(room, currentPlayerId, randomCard);
    }
  }, 30000);
}

function playCard(room, playerId, card) {
  clearTimeout(room.timer);
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;

  const cardIdx = player.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
  if (cardIdx === -1) return;
  player.hand.splice(cardIdx, 1);

  room.handCards.push({ playerId, card, orderIndex: room.currentTurnIndex });
  room.currentTurnIndex++;

  if (room.currentTurnIndex >= room.currentTurnOrder.length) {
    resolveHand(room);
  } else {
    broadcastState(room);
    startPlayTimer(room);
  }
}

function resolveHand(room) {
  let winner = room.handCards[0];
  for (const hc of room.handCards) {
    if (hc.card.value > winner.card.value ||
        (hc.card.value === winner.card.value && hc.orderIndex < winner.orderIndex)) {
      winner = hc;
    }
  }

  const winnerPlayer = room.players.find(p => p.id === winner.playerId);
  if (winnerPlayer) winnerPlayer.tricksTaken++;

  room.lastHandWinner = winner.playerId;
  room.lastHandCards = [...room.handCards];
  room.currentHandIndex++;

  const active = getActivePlayers(room);
  if (active[0].hand.length === 0) {
    resolveRound(room);
  } else {
    broadcastState(room);
    setTimeout(() => {
      room.handCards = [];
      room.lastHandCards = [];
      room.currentTurnOrder = getTurnOrder(room);
      room.currentTurnIndex = 0;
      broadcastState(room);
      startPlayTimer(room);
    }, 1500);
  }
}

function resolveRound(room) {
  room.phase = 'roundEnd';
  const active = getActivePlayers(room);

  active.forEach(p => {
    const diff = Math.abs(p.tricksTaken - p.bet);
    p.lives -= diff;
    if (p.lives <= 0) {
      p.lives = 0;
      p.eliminated = true;
    }
  });

  broadcastState(room);

  const survivors = getActivePlayers(room);
  if (survivors.length <= 1) {
    endGame(room);
    return;
  }

  setTimeout(() => {
    room.roundIndex++;
    room.cardsThisRound = getRoundCards(room.roundIndex);
    room.dealerId = nextDealerIndex(room);
    startRound(room);
  }, 3000);
}

function endGame(room) {
  room.phase = 'finished';
  const survivors = getActivePlayers(room);
  const winner = survivors[0] || room.players.reduce((a, b) => a.lives > b.lives ? a : b);
  room.winnerId = winner.id;
  broadcastState(room);
}

function broadcastState(room) {
  room.players.forEach(player => {
    const socket = io.sockets.sockets.get(player.id);
    if (!socket) return;

    const forbidden = room.phase === 'betting' ? getForbiddenBet(room) : null;
    const currentBettorId = room.betOrder ? room.betOrder[room.currentBetPlayerIndex] : null;
    const currentPlayerId = room.currentTurnOrder ? room.currentTurnOrder[room.currentTurnIndex] : null;

    socket.emit('gameState', {
      phase: room.phase,
      roundIndex: room.roundIndex,
      cardsThisRound: room.cardsThisRound,
      currentHandIndex: room.currentHandIndex,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        photo: p.photo || null,
        lives: p.lives,
        maxLives: p.maxLives,
        bet: p.bet,
        tricksTaken: p.tricksTaken,
        eliminated: p.eliminated,
        isDealer: p.id === room.dealerId,
        cardCount: p.hand ? p.hand.length : 0,
      })),
      myHand: player.hand || [],
      handCards: room.handCards || [],
      lastHandCards: room.lastHandCards || [],
      lastHandWinner: room.lastHandWinner || null,
      currentBettorId,
      currentPlayerId,
      forbiddenBet: forbidden,
      betOrder: room.betOrder || [],
      timerEndsAt: room.timerEndsAt || null,
      winnerId: room.winnerId || null,
      isMyTurn: room.phase === 'betting'
        ? currentBettorId === player.id
        : currentPlayerId === player.id,
    });
  });
}

const PLAYER_COLORS = ['#E74C3C','#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E67E22','#E91E63'];

io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('createRoom', ({ name, lives, photo }) => {
    const code = generateCode();
    const player = {
      id: socket.id, name, color: PLAYER_COLORS[0],
      photo: photo || null,
      lives, maxLives: lives, bet: null, tricksTaken: 0, hand: [], eliminated: false,
    };
    rooms[code] = {
      code, hostId: socket.id, players: [player], phase: 'lobby', lives,
      roundIndex: 0, cardsThisRound: 6, dealerId: null,
      betOrder: [], currentBetPlayerIndex: 0,
      currentTurnOrder: [], currentTurnIndex: 0,
      handCards: [], lastHandCards: [], currentHandIndex: 0,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { code });
    broadcastState(rooms[code]);
  });

  socket.on('joinRoom', ({ code, name, photo }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Sala no encontrada'); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'La partida ya ha empezado'); return; }
    if (room.players.length >= 8) { socket.emit('error', 'Sala llena (máximo 8 jugadores)'); return; }
    const color = PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];
    const player = {
      id: socket.id, name, color,
      photo: photo || null,
      lives: room.lives, maxLives: room.lives, bet: null, tricksTaken: 0, hand: [], eliminated: false,
    };
    room.players.push(player);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomJoined', { code });
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) { socket.emit('error', 'Mínimo 3 jugadores'); return; }
    room.dealerId = room.players[Math.floor(Math.random() * room.players.length)].id;
    startRound(room);
  });

  socket.on('placeBet', ({ bet }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'betting') return;
    const currentBettorId = room.betOrder[room.currentBetPlayerIndex];
    if (currentBettorId !== socket.id) return;
    const forbidden = getForbiddenBet(room);
    if (bet === forbidden) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.bet = bet;
    advanceBetting(room);
  });

  socket.on('playCard', ({ card }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'playing') return;
    const currentPlayerId = room.currentTurnOrder[room.currentTurnIndex];
    if (currentPlayerId !== socket.id) return;
    playCard(room, socket.id, card);
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.players = room.players.filter(p => p.id !== playerId);
    const kicked = io.sockets.sockets.get(playerId);
    if (kicked) kicked.emit('kicked');
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.disconnected = true;
    broadcastState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pecharro server running on port ${PORT}`));
