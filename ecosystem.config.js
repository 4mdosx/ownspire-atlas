module.exports = {
  apps: [
    {
      name: 'creative-atlas',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 5600',
      cwd: __dirname,
      env: {
      NODE_ENV: 'production',
      PORT: '5600',
},
    },
  ],
}