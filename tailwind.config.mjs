/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        dark: '#1a1a2e',
        panel: '#16213e',
        card: '#1f2b47',
        border: '#2a3a5a',
        'accent-left': '#6366f1',
        'accent-right': '#ec4899',
        urgent: '#ef4444',
        soon: '#f59e0b',
        normal: '#22c55e',
        done: '#6b7280',
      },
      animation: {
        'pulse-urgent': 'pulse-urgent 1.5s infinite',
        'bounce-icon': 'bounce-icon 1s infinite',
        'slide-down': 'slide-down 0.3s ease-out',
        'glow': 'glow 2s infinite',
      },
      keyframes: {
        'pulse-urgent': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(239, 68, 68, 0.5)' },
          '50%': { boxShadow: '0 0 0 10px rgba(239, 68, 68, 0)' },
        },
        'bounce-icon': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        'slide-down': {
          from: { transform: 'translateY(-100%)' },
          to: { transform: 'translateY(0)' },
        },
        'glow': {
          '0%, 100%': { background: 'transparent' },
          '50%': { background: 'rgba(239, 68, 68, 0.05)' },
        },
      },
    },
  },
  plugins: [],
};
