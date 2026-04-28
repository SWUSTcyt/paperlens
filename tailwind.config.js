/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './entrypoints/**/*.{html,ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // PaperLens 主色：学术蓝，参考 arXiv 品牌的红但偏冷静
        brand: {
          50: '#eef4ff',
          100: '#d9e5ff',
          200: '#b5c8ff',
          300: '#8aa4ff',
          400: '#5b7aff',
          500: '#3757f2',
          600: '#253fcc',
          700: '#1e329c',
          800: '#1a2a7a',
          900: '#192763',
        },
      },
      fontFamily: {
        sans: [
          '"Inter"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
