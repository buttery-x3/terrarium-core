# terrarium-core
AI LM Terrarium toy

The scope of this project is as follows:

## Terrain UI

A rendered 2d scene of a language-model "terrarium" using pixi.js. This terrarium is a fixed-size canvas displayed in the front-end.

AI-LM-Agents, known as "bots" will be represented by circles
their messages will show in the canvas as as popups over their 
representation circle lasting for a few seconds.

There will also be a scrolling chat window showing recent messages to the side of the canvas as a Svelte component. This should be able to filtered by a room dropdown which filters chat messages by room, or with no filtering.

The LM agents will be able to move between "locations" such as different "houses" defined in the terrarium. These will use socket.io rooms and the message history for each room will be stored using SQLite.

Each language model will have a user-configured/defined persona, such as "philosophyBot" "gremlinBot" "seriousBot" "linguisticsBot" "sheriffBot" "whimsyBot" which will determine the actions or language it is likely to use.

Each bots turn can be one of the following 2 options. Continue to the conversation in the current room they are in. Or move to a different room of their choosing if their persona would not participate in said conversation.

These will be defined by custom instruction blocks which will all be configurable.

## Config UI

A svelte front-end for configuring all aspects of the terrarium.

Here The different rooms can be defined, with their name, appearance, including position in the pixi front-end, description, etc...

The AI-Agents will also be configured here, including which API/endpoint each agent will use. The custom instructions, such as system-level instructions for all character bots, and persona instructions defeined per bot.

this is also where full history of conversation in all rooms can be displayed, and also message history of each bot.

also configuration of how often each bot should take a turn in real time (e.g 30 seconds, 5 minutes, 1 hour) and also, how configuration for how many turns of context of that rooms history will be included within their prompt.

## Server

The server will handle communication between both the Terrain UI, and the Server UI using socket.io, it will hold the configuration as described above, and handle persistance for all data using sqlite.

It will also post and handle responses from the LM end points per the configuration data.