<script lang="ts">
  import { Application, Graphics, Text } from "pixi.js";
  import { onMount } from "svelte";
  import { io } from "socket.io-client";
  import type { ConversationMessage, HistoryCleared } from "@terrarium/shared";

  let container: HTMLDivElement | null = null;
  let app: Application | null = null;
  const socket = io("/terrain", { transports: ["websocket"] });
  const rooms: string[] = [];
  const roomStates = new Map<
    string,
    {
      graphics: Graphics;
      label: Text;
      message: Text;
      highlightUntil: number;
    }
  >();

  const baseColor = 0x0ea5e9;
  const highlightColor = 0xf97316;
  const size = 50;
  const spacing = 100;
  const columns = 3;
  const startX = 100;
  const startY = 100;

  const drawRoom = (graphics: Graphics, color: number) => {
    graphics.clear();
    graphics.rect(0, 0, size, size).fill({ color });
  };

  const renderRooms = () => {
    const currentApp = app;
    if (!currentApp) return;
    rooms.forEach((roomId, index) => {
      if (roomStates.has(roomId)) return;
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = startX + col * spacing;
      const y = startY + row * spacing;

      const graphics = new Graphics();
      drawRoom(graphics, baseColor);
      graphics.position.set(x, y);

      const label = new Text({
        text: roomId,
        style: {
          fill: 0xe2e8f0,
          fontSize: 12,
        },
      });
      label.position.set(x, y - 20);

      const message = new Text({
        text: "",
        style: {
          fill: 0xfbbf24,
          fontSize: 12,
        },
      });
      message.position.set(x, y + size + 8);

      currentApp.stage.addChild(graphics, label, message);
      roomStates.set(roomId, {
        graphics,
        label,
        message,
        highlightUntil: 0,
      });
    });
  };

  const updateHighlights = (now: number) => {
    roomStates.forEach((state) => {
      if (state.highlightUntil <= 0) {
        drawRoom(state.graphics, baseColor);
        return;
      }

      const remaining = Math.max(0, state.highlightUntil - now);
      const ratio = Math.min(1, remaining / 1000);
      const color = blendColor(baseColor, highlightColor, ratio);
      drawRoom(state.graphics, color);
      if (remaining === 0) {
        state.highlightUntil = 0;
      }
    });
  };

  const clearMessages = (roomIds: string[]) => {
    roomIds.forEach((id) => {
      const room = roomStates.get(id);
      if (!room) return;
      room.message.text = "";
      room.highlightUntil = 0;
      drawRoom(room.graphics, baseColor);
    });
  };

  const blendColor = (from: number, to: number, ratio: number) => {
    const fromR = (from >> 16) & 0xff;
    const fromG = (from >> 8) & 0xff;
    const fromB = from & 0xff;
    const toR = (to >> 16) & 0xff;
    const toG = (to >> 8) & 0xff;
    const toB = to & 0xff;
    const r = Math.round(fromR + (toR - fromR) * ratio);
    const g = Math.round(fromG + (toG - fromG) * ratio);
    const b = Math.round(fromB + (toB - fromB) * ratio);
    return (r << 16) + (g << 8) + b;
  };

  onMount(() => {
    if (!container) return;

    app = new Application();

    app
      .init({
        width: 800,
        height: 600,
        backgroundColor: 0x0f172a,
        antialias: true,
        resolution: devicePixelRatio,
      })
      .then(() => {
        container?.appendChild(app!.canvas);
        renderRooms();
        app?.ticker.add(() => {
          updateHighlights(Date.now());
        });
      });

    socket.on("connect", () => {
      clearMessages([...roomStates.keys()]);
      console.info("terrain connected", socket.id);
    });

    socket.on("connect_error", (error) => {
      console.error("terrain connect error", error);
    });

    socket.on("disconnect", (reason) => {
      console.warn("terrain disconnected", reason);
    });

    socket.on("reconnect_attempt", (attempt) => {
      console.info("terrain reconnect attempt", attempt);
    });

    socket.on("reconnect_error", (error) => {
      console.error("terrain reconnect error", error);
    });

    socket.on("rooms:list", (payload: string[]) => {
      console.info("terrain rooms list received", payload);
      rooms.splice(0, rooms.length, ...payload);
      renderRooms();
    });

    socket.on("conversation:message", (payload: ConversationMessage) => {
      const room = roomStates.get(payload.roomId);
      if (!room) return;
      room.highlightUntil = Date.now() + 1000;
      room.message.text = payload.content;
    });

    socket.on("conversation:cleared", (payload: HistoryCleared) => {
      clearMessages(payload.roomIds);
    });

    return () => {
      app?.destroy(true);
      socket.close();
    };
  });
</script>

<main>
  <h1>Terrarium Terrain</h1>
  <div bind:this={container} class="viewport"></div>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family:
      "Inter",
      system-ui,
      -apple-system,
      sans-serif;
    background: #0b1021;
    color: #e2e8f0;
  }

  main {
    padding: 1rem;
  }

  .viewport {
    border: 1px solid #1e293b;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
  }
</style>
