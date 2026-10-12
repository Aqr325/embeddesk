/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--td-bg-color-page)',
        foreground: 'var(--td-text-color-primary)',
        muted: {
          DEFAULT: 'var(--td-bg-color-component)',
          foreground: 'var(--td-text-color-secondary)',
        },
        border: 'var(--td-component-stroke)',
        input: 'var(--td-bg-color-component)',
        card: {
          DEFAULT: 'var(--td-bg-color-container)',
          foreground: 'var(--td-text-color-primary)',
        },
        accent: {
          DEFAULT: 'rgb(var(--td-brand-color-rgb) / <alpha-value>)',
          foreground: 'var(--td-text-color-anti)',
          light: 'var(--td-brand-color-light)',
        },
        primary: {
          DEFAULT: 'var(--td-text-color-primary)',
          foreground: 'var(--td-bg-color-page)',
        },
        // 语义状态色（由 DESIGN.md 校验，CSS 变量桥接以支持深色模式）
        destructive: {
          DEFAULT: 'var(--color-destructive)',
          foreground: 'var(--color-destructive-foreground)',
          light: 'var(--color-destructive-light)',
        },
        success: {
          DEFAULT: 'var(--color-success)',
          foreground: 'var(--color-success-foreground)',
          light: 'var(--color-success-light)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          foreground: 'var(--color-warning-foreground)',
          light: 'var(--color-warning-light)',
        },
        info: {
          DEFAULT: 'var(--color-info)',
          foreground: 'var(--color-info-foreground)',
          light: 'var(--color-info-light)',
        },
      },
      borderRadius: {
        xl: '16px',
        '2xl': '20px',
      },
      // 统一过渡属性，组件用 transition-base 即可获得一致动效
      transitionProperty: {
        base: 'color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform',
      },
      animation: {
        'cursor-blink': 'blink 1s infinite',
        'fade-in': 'fade-in 0.3s ease-out both',
        'fade-in-up': 'fade-in-up 0.35s ease-out both',
        'slide-in-right': 'slide-in-right 0.3s ease-out both',
        'pop-in': 'pop-in 0.2s ease-out both',
        'shimmer': 'shimmer 1.6s ease-in-out infinite',
      },
      keyframes: {
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
};
