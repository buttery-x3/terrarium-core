<script lang="ts">
  import { io } from "socket.io-client";
  import { writable } from "svelte/store";

  const socket = io("/config");
  const rooms = writable<string[]>([]);
  const selectedRoom = writable("");
  const message = writable("");

  socket.on("connect", () => {
    console.info("config connected", socket.id);
  });

  socket.on("connect_error", (error) => {
    console.error("config connect error", error);
  });

  socket.on("disconnect", (reason) => {
    console.warn("config disconnected", reason);
  });

  socket.on("reconnect_attempt", (attempt) => {
    console.info("config reconnect attempt", attempt);
  });

  socket.on("reconnect_error", (error) => {
    console.error("config reconnect error", error);
  });

  socket.on("rooms:list", (payload: string[]) => {
    console.info("config rooms list received", payload);
    rooms.set(payload);
    selectedRoom.set(payload[0] ?? "");
  });

  const sendMessage = () => {
    const roomId = $selectedRoom;
    const content = $message;

    if (!roomId || !content) return;
    const outbound = { roomId, message: content };
    socket.emit("config:message", outbound);
    console.info("config message emitted", outbound);
  };
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
  <section>
    <h2>Test Message</h2>
    <div>
      <label>
        Room
        <select bind:value={$selectedRoom}>
          {#each $rooms as room}
            <option value={room}>{room}</option>
          {/each}
        </select>
      </label>
    </div>
    <div>
      <label>
        Message
        <input type="text" bind:value={$message} />
      </label>
    </div>
    <button type="button" on:click={sendMessage}>Send</button>
  </section>
</main>
