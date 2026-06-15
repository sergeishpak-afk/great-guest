const LEVELS = [
  { name: 'Bronze',   emoji: '🥉', minVisits: 1,  maxVisits: 4  },
  { name: 'Silver',   emoji: '🥈', minVisits: 5,  maxVisits: 14 },
  { name: 'Gold',     emoji: '🥇', minVisits: 15, maxVisits: 29 },
  { name: 'Platinum', emoji: '💎', minVisits: 30, maxVisits: Infinity },
];

function getStatus(visitCount) {
  if (visitCount === 0) return null;
  return LEVELS.findLast(l => visitCount >= l.minVisits) || LEVELS[0];
}

function getNextLevel(visitCount) {
  return LEVELS.find(l => l.minVisits > visitCount) || null;
}

function formatStatus(visitCount) {
  if (visitCount === 0) {
    return `🎉 *Добро пожаловать!*\nПолучи QR-код и посети первый ресторан-партнёр.\nДо 🥉 Bronze: 1 визит`;
  }

  const current = getStatus(visitCount);
  const next = getNextLevel(visitCount);
  const visitsToNext = next ? next.minVisits - visitCount : 0;

  let text = `${current.emoji} *${current.name}*\nВизитов: ${visitCount}`;
  if (next) {
    text += `\nДо ${next.emoji} ${next.name}: ещё ${visitsToNext} ${declVisit(visitsToNext)}`;
  } else {
    text += `\n🏆 Максимальный статус!`;
  }
  return text;
}

function declVisit(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'визит';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'визита';
  return 'визитов';
}

module.exports = { getStatus, getNextLevel, formatStatus };
