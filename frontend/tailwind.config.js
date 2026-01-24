/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        calendar: {
          border: "#eef2f7",
          bg: "#ffffff",
          today: "#1677ff",
        }
      },
      boxShadow: {
        soft: "0 2px 8px rgba(9,30,66,0.05)",
      },
      borderRadius: {
        xl: "12px",
      }
    },
  },
  plugins: [],
}
