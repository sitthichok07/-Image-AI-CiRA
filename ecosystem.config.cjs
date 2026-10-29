const path = require("path");

module.exports = {
  apps: [
    {
      name: "cira-inspection-server",
      script: "run_system.py",
      cwd: __dirname,
      interpreter: "C:\\Users\\mtl80343\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      restart_delay: 2000,
      min_uptime: "5s",
      max_restarts: 10,
      env: {
        PYTHONUNBUFFERED: "1",
        PORT: 9999,
        HOST: "0.0.0.0"
      }
    }
  ]
};
