/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Vazirmatn', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        ink: {
          950: '#050811',
          900: '#070c17',
          850: '#0a111f',
          800: '#0d1526',
          700: '#111c31',
        },
        accent: {
          DEFAULT: '#10b981',
          soft: '#34d399',
          dim: '#059669',
        },
        cyanx: '#22d3ee',
        violetx: '#a78bfa',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(16,185,129,.25), 0 12px 48px -12px rgba(16,185,129,.35)',
        soft: '0 18px 60px -24px rgba(0,0,0,.85)',
        card: '0 1px 0 rgba(255,255,255,.04) inset, 0 24px 60px -36px rgba(0,0,0,.9)',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: 0, transform: 'translateY(10px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: 0 },
          '100%': { opacity: 1 },
        },
        pulseGlow: {
          '0%,100%': { opacity: '.45' },
          '50%': { opacity: '.9' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-700px 0' },
          '100%': { backgroundPosition: '700px 0' },
        },
      },
      animation: {
        fadeUp: 'fadeUp .45s cubic-bezier(.22,1,.36,1) both',
        fadeIn: 'fadeIn .35s ease both',
        pulseGlow: 'pulseGlow 4s ease-in-out infinite',
        shimmer: 'shimmer 1.8s linear infinite',
      },
    },
  },
  plugins: [],
};
