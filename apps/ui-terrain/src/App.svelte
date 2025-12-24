<script lang="ts">
  import { Application, Graphics } from "pixi.js";
  import { onMount } from "svelte";
  import { io } from "socket.io-client";

  let container: HTMLDivElement | null = null;
  let app: Application | null = null;
  const socket = io("/terrain");

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

        const room = new Graphics();
        room.rect(50, 50, 700, 500).fill({ color: 0x0ea5e9 });
        app?.stage.addChild(room);
      });

    socket.on("connect", () => {
      console.info("terrain connected", socket.id);
    });

    socket.on("agent:update", (payload) => {
      console.info("agent update", payload);
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
