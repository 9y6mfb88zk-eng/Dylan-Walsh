const q = new URLSearchParams(location.search);
document.getElementById("url").value = q.get("url") || "";
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err"), btn = document.getElementById("go");
  let url = document.getElementById("url").value.trim();
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  err.textContent = ""; btn.disabled = true; btn.textContent = "Checking…";
  const r = await window.setup.test(url);
  if (!r.ok) { err.textContent = `Couldn't reach JARVIS: ${r.error}`; btn.disabled = false; btn.textContent = "Connect"; return; }
  await window.setup.save(url);
});
