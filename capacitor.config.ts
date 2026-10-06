import type { CapacitorConfig } from '@capacitor/cli';

// This turns the built WeatherGPT web app into an installable native
// Android/iOS app (fulfils "mobile-based conversational AI platform").
// The app still talks to the same Express/WebSocket backend over HTTPS —
// point `server.url` at your deployed backend before building for a device.
const config: CapacitorConfig = {
  appId: 'com.weathergpt.app',
  appName: 'WeatherGPT',
  webDir: 'dist',
  server: {
    // For local device testing against a backend running on your machine,
    // replace with your machine's LAN IP, e.g. 'http://192.168.1.5:3000'.
    // For production, point this at your deployed HTTPS backend URL.
    url: 'http://10.148.209.224:3000',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
