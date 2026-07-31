// Vercel Edge Function: /api/og-pitch → 1200×630 PNG
// Uses @vercel/og with React.createElement (no JSX build needed)
import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

export default function handler() {
  const el = (tag, props, ...children) =>
    ({ type: tag, props: { ...props, children: children.length === 1 ? children[0] : children } });

  return new ImageResponse(
    el('div', {
      style: {
        display: 'flex', flexDirection: 'column',
        width: '1200px', height: '630px',
        background: '#111', padding: '80px',
        fontFamily: 'sans-serif', position: 'relative',
      }
    },
      // Gold bar
      el('div', { style: { position: 'absolute', top: 0, left: 0, right: 0, height: '6px', background: 'linear-gradient(90deg,#c9a96e,#e8c97e,#c9a96e)' } }),
      // Badge
      el('div', { style: { display: 'flex', background: '#222', border: '1px solid #333', borderRadius: '999px', padding: '8px 24px', marginBottom: '36px', width: 'fit-content' } },
        el('span', { style: { color: '#c9a96e', fontSize: '14px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' } }, 'Seed Pitch · 2026')
      ),
      // Main title
      el('div', { style: { display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'center' } },
        el('div', { style: { fontSize: '80px', fontWeight: 800, color: '#f0f0f0', lineHeight: 1.05, marginBottom: '24px' } },
          'Great', el('span', { style: { color: '#c9a96e' } }, 'Guest')
        ),
        el('div', { style: { fontSize: '28px', color: '#888', maxWidth: '680px', lineHeight: 1.4 } },
          'Loyalty 2.0 для HoReCa через Telegram. AI Win-back · Единый профиль · Запуск за 15 мин.'
        )
      ),
      // Bottom stats
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '40px' } },
        el('div', { style: { display: 'flex', gap: '40px' } },
          ...[['8+', 'гостей в MVP'], ['3', 'ресторана'], ['0₽', 'для регистрации']].map(([n, l]) =>
            el('div', { style: { display: 'flex', flexDirection: 'column' } },
              el('span', { style: { fontSize: '36px', fontWeight: 700, color: '#c9a96e' } }, n),
              el('span', { style: { fontSize: '14px', color: '#555', marginTop: '2px' } }, l)
            )
          )
        ),
        el('div', { style: { color: '#444', fontSize: '14px' } }, 'great-guest.ru')
      )
    ),
    { width: 1200, height: 630 }
  );
}
