<script lang="ts">
  import { io } from "socket.io-client";
  import { writable } from "svelte/store";

  const socket = io("/config");
  const rooms = writable<string[]>(["room-1"]);

  socket.on("connect", () => {
    console.info("config connected", socket.id);
  });
</script>

<main>
  <h1>Terrarium Config</h1>
  <section>
    <h2>Rooms</h2>
    <ul>
      {#each $rooms as room}
        <li>{room}</li>
      {/each}
    </ul>
  </section>
</main>
