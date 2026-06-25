const LEVELS = [
  { name: 'Bronze',   emoji: '🥉', minVisits: 1,  maxVisits: 4,        reward: 'Добро пожаловать в программу' },
  { name: 'Silver',   emoji: '🥈', minVisits: 5,  maxVisits: 14,       reward: 'Скидка 5% + приоритетная бронь' },
  { name: 'Gold',     emoji: '🥇', minVisits: 15, maxVisits: 29,       reward: 'Скидка 10% + комплимент от шефа' },
  { name: 'Platinum', emoji: '💎', minVisits: 30, maxVisits: Infinity, reward: 'Скидка 15% + VIP-обслуживание' },
];

const VIP_LEVEL = { name: 'VIP', emoji: '👑', minVisits: 0, maxVisits: Infinity, reward: 'Особый гость' };

const VALID_OVERRIDES = ['Bronze', 'Silver', 'Gold', 'Platinum', 'VIP'];

function getStatus(visitCount) {
  if (visitCount === 0) return null;
  return LEVELS.findLast(l => visitCount >= l.minVisits) || LEVELS[0];
}

// Returns override level if set, otherwise auto-calculates from visits.
function getEffectiveStatus(visitCount, override) {
  if (override === 'VIP') return VIP_LEVEL;
  if (override) {
    const found = LEVELS.find(l => l.name === override);
    if (found) return found;
  }
  return getStatus(visitCount);
}

function getNextLevel(visitCount) {
  return LEVELS.find(l => l.minVisits > visitCount) || null;
}

function formatStatus(visitCount, override) {
  const effective = getEffectiveStatus(visitCount, override);

  if (!effective) {
    return `🎉 *Добро пожаловать!*\nПолучи QR-код и посети первый ресторан-партнёр.\nДо 🥉 Bronze: 1 визит`;
  }

  const isManual = !!override;
  const next = isManual ? null : getNextLevel(visitCount);
  const visitsToNext = next ? next.minVisits - visitCount : 0;

  let text = `${effective.emoji} *${effective.name}*\nВизитов: ${visitCount}`;
  if (isManual) {
    text += `\n✨ Статус присвоен организатором`;
  } else if (next) {
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

module.exports = { LEVELS, VIP_LEVEL, VALID_OVERRIDES, getStatus, getEffectiveStatus, getNextLevel, formatStatus };
