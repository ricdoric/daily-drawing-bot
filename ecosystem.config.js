module.exports = {
  apps: [
    {
      name: "daily-drawing-bot",
      script: "./dist/index.js",
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
