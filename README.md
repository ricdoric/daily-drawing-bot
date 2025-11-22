# Daily Drawing Bot
Discord bot for managing daily drawing challenges

## MVP Features
These features will be the base functions of the bot
- Counts votes on daily drawing thread at specified deadline, notifies winner in chat
- Ignores drawings with :timer: emoji, marked as overtime so doesn't count toward rankings
    - User who posted the image can mark it, or specified admins/mods can mark it. Ignores any others adding the :timer: emoji
- When user creates new forum thread for the next daily, the bot posts the rules as the top post
- Mod commands
    - /daily-deadline - forces a tally to occur if the bot was offline during the deadline time
    - /daily-off - disables bot
    - /daily-on - enables bot
    - /daily-status - responds whether the bot is either enabled or disabled
    - The bot will default to being disabled if the server restarts or an error occurs, as to not have issues and ping winners more than once

## Future Features
These are ideas for features in the future, they are not currently implemented
- If pinged 1st place user fails to post new theme in 30 minutes, bot pings 2nd place, then 30 more minutes, pings 3rd place
- All users can have the option to use /daily-theme command
    - This opens a modal with 2 form fields for the daily theme and optional discription
    - If that user wins the daily, the bot will automatically post their theme in the forum, then remove the saved theme so it doesn't get posted again without the user knowing
    - If they still have a theme saved, it displays what it is and gives an option to replace it
    - /daily-theme-clear to clear out user's theme
- Language processing to determine if user mentioned being over time, adding :timer: emoji to drawing
    - Still will need a mod or poster to add another :timer: emoji for it to be skipped

## Development
Create a `.env` file follwing the `.env.example` file. Setup your discord developer account: https://discord.com/developers/docs/intro and follow the instructions to create a new app and populate the token and client id in the .env file.

Either create a new server for testing your build of the bot, or ask me (ricdoric) and I can grant permissions for your build on the test server I'm using.

`npm install` to get all packages

`npm start` to build and run the bot locally