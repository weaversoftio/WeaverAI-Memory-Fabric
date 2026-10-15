import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * Semantic colors -- all bridged to Tea Design Tokens (--tea-color-*),
         * no longer using shadcn's HSL triplet system.
         * See the :root definitions in src/index.css for the specific alias mapping.
         * Note: the opacity modifier of Tailwind v3.4+ (e.g. bg-primary/50) is implemented through color-mix(),
         * which works for any valid CSS color value (including var() references), with no need for an <alpha-value> placeholder.
         */
        background: {
          DEFAULT: 'var(--background)',
          deep: 'var(--background-deep)'
        },
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)'
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)'
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)'
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)'
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)'
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          foreground: 'var(--accent-foreground)'
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)'
        },
        success: {
          DEFAULT: 'var(--success)',
          foreground: 'var(--success-foreground)'
        },
        warning: {
          DEFAULT: 'var(--warning)',
          foreground: 'var(--warning-foreground)'
        },
        heavy: {
          DEFAULT: 'var(--heavy)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)'
      },
      borderRadius: {
        /* Aligned with the Tea Design radius scale: 2/4/6/8/12/16/20/30/9999px */
        sm: '2px',
        DEFAULT: '4px',
        md: '4px',
        lg: '6px',
        xl: '8px',
        '2xl': '12px',
        '3xl': '16px',
        full: '9999px'
      },
      fontSize: {
        /** Template-aligned: body 14px/1.6, small text 12-13px */
        'body': ['14px', { lineHeight: '1.6', letterSpacing: '-0.01em' }],
        'body-sm': ['13px', { lineHeight: '1.5', letterSpacing: '-0.006em' }],
        'caption': ['12px', { lineHeight: '1.4' }],
        'label': ['11px', { lineHeight: '1.3' }],
      },
      spacing: {
        /** Template-aligned common spacing */
        '4.5': '1.125rem',
        '5.5': '1.375rem',
        '13': '3.25rem',
        '15': '3.75rem',
      },
      boxShadow: {
        /* Directly references Tea's official shadow tokens (--tea-shadow-*), no longer hand-writing hsl() shadows */
        'card': 'var(--tea-shadow-xs)',
        'card-hover': 'var(--tea-shadow-md)',
      },
      transitionDuration: {
        '150': '150ms',
      },
      animation: {
        'press': 'press 0.1s ease-out',
      },
      keyframes: {
        press: {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(0.97)' },
          '100%': { transform: 'scale(1)' },
        },
      },
    }
  },
  plugins: [typography]
};
