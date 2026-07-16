import express from "express";
import http from "http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3000;
const SUITS = ["S", "H", "C", "D"];
const RED_SUITS = new Set(["H", "D"]);
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const POINTS = { "5": 5, "10": 10, K: 10 };
const TRUMP_NAMES = { S: "黑桃", H: "红桃", C: "梅花", D: "方块", NT: "无主" };
const ROOM_TTL_MS = 1000 * 60 * 60 * 8;
const DEAL_INTERVAL_MS = 115;
const TRICK_REVIEW_MS = 1600;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

function id(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 9);
}

function roomCode() {
  let code;
  do code = Math.random().toString(36).slice(2, 6).toUpperCase();
  while (rooms.has(code));
  return code;
}

function makeDeck() {
  const deck = [];
  let n = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ id: `${suit}${rank}-${copy}`, suit, rank, copy, point: POINTS[rank] || 0 });
      }
    }
    deck.push({ id: `BJ-${copy}`, suit: "JOKER", rank: "BJ", copy, point: 0 });
    deck.push({ id: `RJ-${copy}`, suit: "JOKER", rank: "RJ", copy, point: 0 });
  }
  return deck.map((c) => ({ ...c, uid: `${c.id}-${n++}` }));
}

function shuffle(cards) {
  const a = [...cards];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function teamOf(seat) {
  return seat % 2;
}

function nextSeat(seat, step = 1) {
  return (seat + step) % 4;
}

function rankIndex(rank) {
  return RANKS.indexOf(rank);
}

function cardLabel(card) {
  const suit = { S: "♠", H: "♥", C: "♣", D: "♦", JOKER: "" }[card.suit];
  if (card.rank === "BJ") return "小王";
  if (card.rank === "RJ") return "大王";
  return `${suit}${card.rank}`;
}

function groupKey(card, trump) {
  if (card.rank === "RJ") return "RJ";
  if (card.rank === "BJ") return "BJ";
  if (card.rank === trump.level) return `L${card.suit}`;
  return `${isTrump(card, trump) ? "T" : "N"}${card.suit}${card.rank}`;
}

function isTrump(card, trump) {
  if (card.suit === "JOKER") return true;
  if (card.rank === trump.level) return true;
  return trump.suit !== "NT" && card.suit === trump.suit;
}

function logicalSuit(card, trump) {
  return isTrump(card, trump) ? "TRUMP" : card.suit;
}

function cardOrder(card, trump) {
  if (card.rank === "RJ") return 1000;
  if (card.rank === "BJ") return 990;
  if (card.rank === trump.level && trump.suit !== "NT" && card.suit === trump.suit) return 980;
  if (card.rank === trump.level && RED_SUITS.has(card.suit) === RED_SUITS.has(trump.suit)) return 970;
  if (card.rank === trump.level) return 960;
  const base = rankIndex(card.rank);
  if (trump.suit !== "NT" && card.suit === trump.suit) return 500 + base;
  return base;
}

function sortHand(hand, trump) {
  return [...hand].sort((a, b) => {
    const ta = isTrump(a, trump) ? 1 : 0;
    const tb = isTrump(b, trump) ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return cardOrder(a, trump) - cardOrder(b, trump);
  });
}

function countBy(cards, keyFn) {
  const m = new Map();
  for (const c of cards) {
    const k = keyFn(c);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function takeCards(hand, ids) {
  const picked = [];
  for (const cid of ids) {
    const idx = hand.findIndex((c) => c.uid === cid);
    if (idx === -1) return null;
    picked.push(hand.splice(idx, 1)[0]);
  }
  return picked;
}

function shapeOf(cards, trump) {
  const groups = [...countBy(cards, (c) => groupKey(c, trump)).entries()];
  if (cards.length === 1) return { type: "single", size: 1, units: [1] };
  if (cards.length === 2 && groups.length === 1) return { type: "pair", size: 2, units: [2] };
  const allPairs = groups.every(([, n]) => n === 2);
  if (allPairs && groups.length >= 2) {
    const ordered = groups
      .map(([k]) => cards.find((c) => groupKey(c, trump) === k))
      .map((c) => cardOrder(c, trump))
      .sort((a, b) => a - b);
    const consecutive = ordered.every((v, i) => i === 0 || v === ordered[i - 1] + 1);
    if (consecutive) return { type: "tractor", size: cards.length, pairs: groups.length, units: groups.map(() => 2) };
  }
  return { type: "throw", size: cards.length, units: groups.map(([, n]) => n).sort((a, b) => b - a) };
}

function canFollow(required, leadSuit, chosen, hand, trump) {
  if (chosen.length !== required.size) return "张数不对";
  const chosenLead = chosen.filter((c) => logicalSuit(c, trump) === leadSuit);
  const handLead = hand.filter((c) => logicalSuit(c, trump) === leadSuit);
  if (handLead.length >= required.size && chosenLead.length !== required.size) return "必须跟同门花色/主牌";
  if (handLead.length < required.size && chosenLead.length !== handLead.length) return "同门花色/主牌还没出完";

  if (chosenLead.length !== required.size) return null;
  const chosenShape = shapeOf(chosen, trump);
  const chosenPairs = [...countBy(chosen, (c) => groupKey(c, trump)).values()].filter((n) => n >= 2).length;
  const handPairs = [...countBy(handLead, (c) => groupKey(c, trump)).values()].filter((n) => n >= 2).length;
  if (required.type === "pair" && handPairs > 0 && chosenShape.type !== "pair") return "有对子时必须跟对子";
  if (required.type === "tractor" && handPairs >= required.pairs && chosenShape.type !== "tractor") return "有足够对子时必须跟拖拉机";
  return null;
}

function canBeatRequiredShape(cards, required, trump) {
  const shape = shapeOf(cards, trump);
  if (required.type === "single") return shape.type === "single";
  if (required.type === "pair") return shape.type === "pair";
  if (required.type === "tractor") return shape.type === "tractor" && shape.size === required.size && shape.pairs === required.pairs;
  return shape.type === required.type && shape.size === required.size && shape.units.join(",") === required.units.join(",");
}

function beats(play, best, trick, trump) {
  if (!canBeatRequiredShape(play.cards, trick.required, trump)) return false;
  const leadSuit = trick.leadSuit;
  const pSuit = logicalSuit(play.cards[0], trump);
  const bSuit = logicalSuit(best.cards[0], trump);
  if (pSuit !== leadSuit) {
    if (pSuit !== "TRUMP") return false;
    if (bSuit !== "TRUMP") return true;
  } else if (bSuit !== leadSuit) {
    return false;
  }
  const pMax = Math.max(...play.cards.map((c) => cardOrder(c, trump)));
  const bMax = Math.max(...best.cards.map((c) => cardOrder(c, trump)));
  return pMax > bMax;
}

function lowestCards(hand, trump, count) {
  return sortHand(hand, trump).slice(0, count).map((c) => c.uid);
}

function chooseBotPlay(room, seat) {
  const player = room.players[seat];
  const hand = player.hand;
  if (!room.trick) {
    const nonPoint = sortHand(hand, room.trump).find((c) => !c.point);
    return [nonPoint || sortHand(hand, room.trump)[0]].map((c) => c.uid);
  }
  const req = room.trick.required;
  const leadSuit = room.trick.leadSuit;
  const handLead = hand.filter((c) => logicalSuit(c, room.trump) === leadSuit);
  if (handLead.length >= req.size) return sortHand(handLead, room.trump).slice(0, req.size).map((c) => c.uid);
  return [
    ...handLead,
    ...sortHand(hand.filter((c) => logicalSuit(c, room.trump) !== leadSuit), room.trump).slice(0, req.size - handLead.length)
  ].map((c) => c.uid);
}

class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.createdAt = Date.now();
    this.hostSocketId = hostSocketId;
    this.players = Array.from({ length: 4 }, (_, seat) => ({
      id: null,
      name: "",
      seat,
      bot: false,
      connected: false,
      hand: []
    }));
    this.logs = [];
    this.phase = "lobby";
    this.levels = [0, 0];
    this.dealerTeam = 0;
    this.dealerSeat = 0;
    this.trump = { suit: "NT", level: "2" };
    this.bidPower = 0;
    this.kitty = [];
    this.buried = [];
    this.turn = 0;
    this.trick = null;
    this.tricks = [];
    this.scores = { attackers: 0 };
    this.lastActionAt = Date.now();
    this.deck = [];
    this.dealIndex = 0;
    this.dealTimer = null;
    this.trickTimer = null;
    this.trickReviewing = false;
    this.currentBid = null;
  }

  log(text) {
    this.logs.push({ at: new Date().toLocaleTimeString(), text });
    this.logs = this.logs.slice(-80);
  }

  snapshot(forSocketId) {
    const meSeat = this.players.findIndex((p) => p.id === forSocketId);
    return {
      code: this.code,
      phase: this.phase,
      host: this.hostSocketId,
      meSeat,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        bot: p.bot,
        connected: p.connected,
        handCount: p.hand.length,
        team: teamOf(p.seat)
      })),
      levels: this.levels.map((i) => RANKS[i]),
      dealerTeam: this.dealerTeam,
      dealerSeat: this.dealerSeat,
      turn: this.turn,
      trump: this.trump,
      bidPower: this.bidPower,
      currentBid: this.currentBid && {
        seat: this.currentBid.seat,
        suit: this.currentBid.suit,
        level: this.currentBid.level,
        power: this.currentBid.power,
        cards: this.currentBid.cards.map(publicCard)
      },
      deal: {
        active: this.phase === "deal",
        dealt: Math.min(this.dealIndex, 100),
        total: 100,
        kitty: 8
      },
      kittyCount: this.kitty.length,
      buriedCount: this.buried.length,
      scores: this.scores,
      trick: this.trick && {
        leader: this.trick.leader,
        leadSuit: this.trick.leadSuit,
        required: this.trick.required,
        plays: this.trick.plays.map((p) => ({ seat: p.seat, cards: p.cards.map(publicCard) })),
        bestSeat: this.trick.bestSeat,
        reviewing: this.trickReviewing
      },
      hand: meSeat >= 0 ? sortHand(this.players[meSeat].hand, this.trump).map(publicCard) : [],
      logs: this.logs
    };
  }

  join(socket, name) {
    const existing = this.players.find((p) => p.id === socket.id);
    if (existing) return existing.seat;
    const seat = this.players.findIndex((p) => !p.id && !p.bot);
    if (seat === -1) throw new Error("房间已满");
    Object.assign(this.players[seat], { id: socket.id, name: name || `玩家${seat + 1}`, bot: false, connected: true });
    this.log(`${this.players[seat].name} 入座 ${seat + 1}`);
    return seat;
  }

  addBot() {
    const seat = this.players.findIndex((p) => !p.id && !p.bot);
    if (seat === -1) throw new Error("没有空座");
    Object.assign(this.players[seat], { id: id("bot-"), name: `机器人${seat + 1}`, bot: true, connected: true });
    this.log(`机器人入座 ${seat + 1}`);
  }

  canStart() {
    return this.phase === "lobby" && this.players.every((p) => p.id || p.bot);
  }

  start() {
    if (!this.canStart()) throw new Error("需要坐满 4 人/机器人");
    this.clearTimers();
    this.deck = shuffle(makeDeck());
    this.dealIndex = 0;
    this.players.forEach((p) => (p.hand = []));
    this.kitty = [];
    this.buried = [];
    this.tricks = [];
    this.scores = { attackers: 0 };
    this.trick = null;
    this.trickReviewing = false;
    this.currentBid = null;
    this.dealerTeam = teamOf(this.dealerSeat);
    this.trump = { suit: "NT", level: RANKS[this.levels[this.dealerTeam]], power: 0 };
    this.bidPower = 0;
    this.phase = "deal";
    this.turn = this.dealerSeat;
    this.log("开始发牌，可在发牌过程中用级牌叫主");
    this.scheduleDeal();
  }

  clearTimers() {
    if (this.dealTimer) clearTimeout(this.dealTimer);
    if (this.trickTimer) clearTimeout(this.trickTimer);
    this.dealTimer = null;
    this.trickTimer = null;
  }

  scheduleDeal() {
    if (this.phase !== "deal") return;
    this.dealTimer = setTimeout(() => this.dealOne(), DEAL_INTERVAL_MS);
  }

  dealOne() {
    if (this.phase !== "deal") return;
    if (this.dealIndex < 100) {
      const seat = this.dealIndex % 4;
      this.players[seat].hand.push(this.deck[this.dealIndex]);
      this.dealIndex += 1;
      emitRoom(this.code);
      this.maybeBotDeclareDuringDeal(seat);
      this.scheduleDeal();
      return;
    }
    this.finishDeal();
  }

  finishDeal() {
    if (this.phase !== "deal") return;
    this.kitty = this.deck.slice(100);
    if (!this.bidPower) {
      this.trump = this.autoDeclare();
      this.bidPower = this.trump.power || 0;
      this.currentBid = this.trump.cards?.length
        ? { seat: this.trump.seat, suit: this.trump.suit, level: this.trump.level, power: this.trump.power, cards: this.trump.cards }
        : null;
    }
    this.players[this.dealerSeat].hand.push(...this.kitty);
    this.kitty = [];
    this.phase = "bury";
    this.turn = this.dealerSeat;
    this.log(`${this.players[this.dealerSeat].name} 定主：${TRUMP_NAMES[this.trump.suit]} ${this.trump.level}，收底扣 8 张`);
    emitRoom(this.code);
    this.botLoop();
  }

  maybeBotDeclareDuringDeal(seat) {
    const player = this.players[seat];
    if (!player.bot || this.bidPower >= 2) return;
    const level = RANKS[this.levels[teamOf(seat)]];
    const candidate = player.hand.find((c) => c.rank === level && SUITS.includes(c.suit));
    if (!candidate) return;
    if (this.dealIndex < 24 && Math.random() < 0.78) return;
    try {
      this.declareTrump(seat, [candidate.uid]);
    } catch {
      // Ignore conservative bot bids that become invalid as state changes.
    }
  }

  autoDeclare() {
    let best = null;
    for (let offset = 0; offset < 4; offset++) {
      const seat = nextSeat(this.dealerSeat, offset);
      const hand = this.players[seat].hand;
      const level = RANKS[this.levels[teamOf(seat)]];
      for (const suit of SUITS) {
        const levelCards = hand.filter((c) => c.rank === level && c.suit === suit);
        const levelCount = levelCards.length;
        if (levelCount) {
          const joker = hand.find((c) => c.rank === (RED_SUITS.has(suit) ? "RJ" : "BJ"));
          const power = levelCount + (joker ? 2 : 0);
          if (!best || power > best.power) best = { seat, suit, level, power, cards: joker ? [...levelCards, joker] : levelCards };
        }
      }
    }
    if (best) {
      this.dealerSeat = best.seat;
      return { suit: best.suit, level: best.level, power: best.power };
    }
    return { suit: "NT", level: RANKS[this.levels[this.dealerTeam]], power: 0 };
  }

  bury(seat, ids) {
    if ((this.phase !== "bury" && this.phase !== "changeBury") || seat !== this.dealerSeat) throw new Error("现在不是你扣底");
    if (ids.length !== 8) throw new Error("必须扣 8 张底牌");
    const cards = takeCards(this.players[seat].hand, ids);
    if (!cards) throw new Error("扣底牌不在手牌中");
    this.buried = cards;
    if (this.phase === "bury") {
      this.phase = "change";
      this.turn = nextSeat(this.dealerSeat);
      this.changePasses = 0;
      this.log(`${this.players[seat].name} 已扣底，开始改主/攻主`);
    } else {
      this.phase = "play";
      this.turn = this.dealerSeat;
      this.log(`${this.players[seat].name} 重扣底，开始出牌`);
    }
    this.botLoop();
  }

  passChange(seat) {
    if (this.phase !== "change" || seat !== this.turn) throw new Error("还没轮到你改主");
    this.changePasses = (this.changePasses || 0) + 1;
    this.log(`${this.players[seat].name} 过`);
    if (this.changePasses >= 3) {
      this.phase = "play";
      this.turn = this.dealerSeat;
      this.log(`改主结束，${this.players[this.dealerSeat].name} 首出`);
    } else {
      this.turn = nextSeat(seat);
      if (this.turn === this.dealerSeat) this.turn = nextSeat(this.turn);
    }
    this.botLoop();
  }

  changeTrump(seat, ids) {
    if (this.phase === "deal") return this.declareTrump(seat, ids);
    if (this.phase !== "change" || seat !== this.turn) throw new Error("还没轮到你改主");
    const cards = ids.map((cid) => this.players[seat].hand.find((c) => c.uid === cid));
    if (cards.length === 0 || cards.some(Boolean) === false || cards.some((c) => !c)) throw new Error("请选择手牌中的改主牌");
    const offer = this.evaluateTrumpOffer(cards, seat);
    if (!offer) throw new Error("只能用级牌、带同色王的级牌，或王对攻无主");
    if (offer.power <= this.bidPower) throw new Error("改主强度必须高于当前定主");
    this.players[seat].hand.push(...this.buried);
    this.buried = [];
    this.trump = { suit: offer.suit, level: offer.level, power: offer.power };
    this.bidPower = offer.power;
    this.dealerSeat = seat;
    this.dealerTeam = teamOf(seat);
    this.currentBid = { seat, suit: offer.suit, level: offer.level, power: offer.power, cards };
    this.phase = "changeBury";
    this.turn = seat;
    this.changePasses = 0;
    this.log(`${this.players[seat].name} 改主为 ${TRUMP_NAMES[offer.suit]} ${offer.level}，收底重扣`);
    this.botLoop();
  }

  declareTrump(seat, ids) {
    if (this.phase !== "deal") throw new Error("现在不能叫主");
    const cards = ids.map((cid) => this.players[seat].hand.find((c) => c.uid === cid));
    if (cards.length === 0 || cards.some((c) => !c)) throw new Error("请选择手牌中的叫主牌");
    const offer = this.evaluateTrumpOffer(cards, seat);
    if (!offer) throw new Error("发牌时只能用本方级牌或王对叫主");
    if (offer.power <= this.bidPower) throw new Error("叫主强度必须高于当前主");
    this.trump = { suit: offer.suit, level: offer.level, power: offer.power };
    this.bidPower = offer.power;
    this.dealerSeat = seat;
    this.dealerTeam = teamOf(seat);
    this.turn = seat;
    this.currentBid = { seat, suit: offer.suit, level: offer.level, power: offer.power, cards };
    this.log(`${this.players[seat].name} 叫主：${TRUMP_NAMES[offer.suit]} ${offer.level}`);
    emitRoom(this.code);
  }

  evaluateTrumpOffer(cards, seat) {
    const level = RANKS[this.levels[teamOf(seat)]];
    const jokerRanks = cards.map((c) => c.rank).sort().join(",");
    if (cards.length === 2 && jokerRanks === "BJ,RJ") return { suit: "NT", level, power: 9 };
    const levels = cards.filter((c) => c.rank === level && SUITS.includes(c.suit));
    if (!levels.length) return null;
    const suit = levels[0].suit;
    if (!levels.every((c) => c.suit === suit)) return null;
    const jokers = cards.filter((c) => c.rank === (RED_SUITS.has(suit) ? "RJ" : "BJ"));
    if (cards.length !== levels.length + jokers.length) return null;
    const power = levels.length + jokers.length * 2;
    return { suit, level, power };
  }

  play(seat, ids) {
    if (this.phase !== "play" || seat !== this.turn) throw new Error("还没轮到你");
    if (this.trickReviewing) throw new Error("本轮结算中，请稍等");
    const hand = this.players[seat].hand;
    const cards = takeCards(hand, ids);
    if (!cards) throw new Error("手牌不存在");
    const rollback = () => hand.push(...cards);
    if (!this.trick) {
      const suit = logicalSuit(cards[0], this.trump);
      if (!cards.every((c) => logicalSuit(c, this.trump) === suit)) {
        rollback();
        throw new Error("首家必须出同一门花色/主牌");
      }
      const required = shapeOf(cards, this.trump);
      if (required.type === "throw" && !this.throwLooksSafe(cards)) {
        rollback();
        throw new Error("甩牌未通过保守校验，请改出单张/对子/拖拉机");
      }
      this.trick = { leader: seat, leadSuit: suit, required, plays: [], bestSeat: seat };
    } else {
      const err = canFollow(this.trick.required, this.trick.leadSuit, cards, hand.concat(cards), this.trump);
      if (err) {
        rollback();
        throw new Error(err);
      }
    }
    this.trick.plays.push({ seat, cards });
    const currentBest = this.trick.plays.find((p) => p.seat === this.trick.bestSeat);
    if (this.trick.plays.length === 1 || beats({ seat, cards }, currentBest, this.trick, this.trump)) {
      this.trick.bestSeat = seat;
    }
    this.log(`${this.players[seat].name} 出 ${cards.map(cardLabel).join(" ")}`);
    if (this.trick.plays.length === 4) this.scheduleFinishTrick();
    else this.turn = nextSeat(seat);
    this.botLoop();
  }

  throwLooksSafe(cards) {
    const groups = countBy(cards, (c) => groupKey(c, this.trump));
    return [...groups.values()].every((n) => n <= 2);
  }

  finishTrick() {
    const trick = this.trick;
    if (!trick) return;
    const winner = trick.bestSeat;
    const points = trick.plays.flatMap((p) => p.cards).reduce((sum, c) => sum + c.point, 0);
    if (teamOf(winner) !== this.dealerTeam) this.scores.attackers += points;
    this.tricks.push(trick);
    this.log(`${this.players[winner].name} 赢得本轮，${points} 分`);
    this.trick = null;
    this.trickReviewing = false;
    this.turn = winner;
    if (this.players.every((p) => p.hand.length === 0)) this.finishRound(winner);
    emitRoom(this.code);
    this.botLoop();
  }

  scheduleFinishTrick() {
    this.trickReviewing = true;
    const winner = this.trick.bestSeat;
    this.turn = winner;
    if (this.trickTimer) clearTimeout(this.trickTimer);
    this.trickTimer = setTimeout(() => {
      this.trickTimer = null;
      this.finishTrick();
    }, TRICK_REVIEW_MS);
  }

  finishRound(lastWinner) {
    const baseKitty = this.buried.reduce((sum, c) => sum + c.point, 0);
    const shape = this.tricks.at(-1)?.required;
    const multiplier = shape?.type === "tractor" ? 4 : shape?.type === "pair" ? 2 : 1;
    if (teamOf(lastWinner) !== this.dealerTeam) this.scores.attackers += baseKitty * multiplier;
    const score = this.scores.attackers;
    const attackersWin = score >= 80;
    const advance = score < 40 ? 3 : score < 80 ? 2 : score < 120 ? 1 : score < 160 ? 1 : 2;
    if (attackersWin) {
      this.dealerTeam = 1 - this.dealerTeam;
      this.dealerSeat = nextSeat(lastWinner);
      this.levels[this.dealerTeam] = Math.min(RANKS.length - 1, this.levels[this.dealerTeam] + advance);
      this.log(`抓分方 ${score} 分，上台并升级 ${advance} 级`);
    } else {
      this.levels[this.dealerTeam] = Math.min(RANKS.length - 1, this.levels[this.dealerTeam] + advance);
      this.dealerSeat = nextSeat(this.dealerSeat, 2);
      this.log(`坐庄方守庄成功，抓分方 ${score} 分，坐庄方升级 ${advance} 级`);
    }
    this.phase = "lobby";
    this.players.forEach((p) => (p.hand = []));
    this.turn = this.dealerSeat;
    this.log("本局结束，可重新开始下一局");
  }

  botLoop() {
    setTimeout(() => {
      if (this.phase === "bury" && this.players[this.dealerSeat]?.bot) {
        try {
          this.bury(this.dealerSeat, lowestCards(this.players[this.dealerSeat].hand, this.trump, 8));
        } catch (e) {
          this.log(e.message);
        }
      }
      if (this.phase === "change" && this.players[this.turn]?.bot) {
        try {
          this.passChange(this.turn);
        } catch (e) {
          this.log(e.message);
        }
      }
      if (this.phase === "changeBury" && this.players[this.dealerSeat]?.bot) {
        try {
          this.bury(this.dealerSeat, lowestCards(this.players[this.dealerSeat].hand, this.trump, 8));
        } catch (e) {
          this.log(e.message);
        }
      }
      if (this.phase === "play" && !this.trickReviewing && this.players[this.turn]?.bot) {
        try {
          this.play(this.turn, chooseBotPlay(this, this.turn));
        } catch (e) {
          this.log(e.message);
        }
      }
      emitRoom(this.code);
    }, 650);
  }
}

function publicCard(card) {
  return {
    uid: card.uid,
    suit: card.suit,
    rank: card.rank,
    point: card.point,
    label: cardLabel(card),
    red: card.suit === "H" || card.suit === "D" || card.rank === "RJ"
  };
}

function emitRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.roomCode === code) socket.emit("state", room.snapshot(socket.id));
  }
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  if (!room) throw new Error("未加入房间");
  return room;
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    try {
      const code = roomCode();
      const room = new Room(code, socket.id);
      rooms.set(code, room);
      socket.data.roomCode = code;
      room.join(socket, name);
      cb?.({ ok: true, code });
      emitRoom(code);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    try {
      const room = rooms.get(String(code || "").toUpperCase());
      if (!room) throw new Error("房间不存在");
      socket.data.roomCode = room.code;
      room.join(socket, name);
      cb?.({ ok: true, code: room.code });
      emitRoom(room.code);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("addBot", (_, cb) => action(socket, cb, (room) => room.addBot()));
  socket.on("startGame", (_, cb) => action(socket, cb, (room) => room.start()));
  socket.on("bury", ({ ids }, cb) => action(socket, cb, (room, seat) => room.bury(seat, ids || [])));
  socket.on("passChange", (_, cb) => action(socket, cb, (room, seat) => room.passChange(seat)));
  socket.on("changeTrump", ({ ids }, cb) => action(socket, cb, (room, seat) => room.changeTrump(seat, ids || [])));
  socket.on("play", ({ ids }, cb) => action(socket, cb, (room, seat) => room.play(seat, ids || [])));

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (player) {
      player.connected = false;
      room.log(`${player.name} 断开连接`);
    }
    emitRoom(room.code);
  });
});

function action(socket, cb, fn) {
  try {
    const room = getRoom(socket);
    const seat = room.players.findIndex((p) => p.id === socket.id);
    if (seat === -1) throw new Error("你不在座位上");
    fn(room, seat);
    cb?.({ ok: true });
    emitRoom(room.code);
  } catch (e) {
    cb?.({ ok: false, error: e.message });
    socket.emit("toast", e.message);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const liveHumans = room.players.some((p) => !p.bot && p.connected);
    if (!liveHumans && now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 1000 * 60 * 10);

server.listen(PORT, () => {
  console.log(`Shengji LAN listening on :${PORT}`);
});
