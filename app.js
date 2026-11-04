const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HISTORY_KEY = "rainsmart.calculation-history.v1";
const EFFICIENCY = 0.8;
const $ = (selector) => document.querySelector(selector);

const elements = {
  form: $("#calculator-form"),
  roof: $("#roof-area"),
  location: $("#location-search"),
  locationStatus: $("#location-status"),
  locationResults: $("#location-results"),
  findButton: $(".search-button"),
  useLocation: $("#use-location"),
  dataBadge: $("#data-badge"),
  selectedLocation: $("#selected-location"),
  resultsTitle: $("#results-title"),
  annual: $("#annual-litres"),
  annualSub: $("#annual-sub"),
  monthly: $("#monthly-litres"),
  monthlyRainfall: $("#monthly-rainfall"),
  forecastLitres: $("#forecast-litres"),
  forecastRainfall: $("#forecast-rainfall"),
  save: $("#save-estimate"),
  historyFeedback: $("#history-feedback"),
  chart: $("#rain-chart"),
  rainfallSummary: $("#rainfall-summary"),
  rainfallPeriod: $("#rainfall-period"),
  storage: $("#storage-capacity"),
  capacityFill: $("#capacity-fill"),
  capacityPercent: $("#capacity-percent"),
  peakMonth: $("#peak-month-label"),
  storageCallout: $("#storage-callout"),
  forecastDays: $("#forecast-days"),
  historyList: $("#history-list"),
  clearHistory: $("#clear-history"),
};

const state = { location: null, monthlyRain: null, yearlyRain: null, forecast: null, loading: false, chartMode: "rain" };

function formatNumber(value, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(Math.round(value * (maximumFractionDigits ? 10 ** maximumFractionDigits : 1)) / (maximumFractionDigits ? 10 ** maximumFractionDigits : 1));
}

function setStatus(message, type = "") {
  elements.locationStatus.textContent = message;
  elements.locationStatus.dataset.state = type;
}

function setBadge(text, type = "") {
  elements.dataBadge.classList.toggle("loading", type === "loading");
  elements.dataBadge.classList.toggle("error", type === "error");
  elements.dataBadge.lastChild.textContent = ` ${text.toUpperCase()}`;
}

function placeLabel(place) {
  if (place.isCurrent) return "Your current location";
  return [place.name, place.admin1, place.country].filter((value, index, values) => value && values.indexOf(value) === index).join(", ");
}

function setLoading(loading) {
  state.loading = loading;
  elements.findButton.disabled = loading;
  elements.findButton.innerHTML = loading ? "Loading…" : 'Find <span aria-hidden="true">→</span>';
  if (loading) setBadge("Loading weather", "loading");
}

async function searchPlaces(query) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: query, count: "5", language: "en", format: "json" });
  const response = await fetch(url);
  if (!response.ok) throw new Error("Location search is unavailable right now.");
  const payload = await response.json();
  return payload.results || [];
}

function renderPlaceChoices(places) {
  elements.locationResults.replaceChildren();
  if (!places.length) {
    elements.locationResults.hidden = false;
    elements.locationResults.innerHTML = '<button type="button" disabled><span class="place-name">No matching places found</span><span class="place-detail">Try a nearby city or postcode.</span></button>';
    elements.location.setAttribute("aria-expanded", "true");
    return;
  }
  for (const place of places) {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    const name = document.createElement("span");
    name.className = "place-name";
    name.textContent = place.name;
    const detail = document.createElement("span");
    detail.className = "place-detail";
    detail.textContent = [place.admin1, place.country].filter(Boolean).join(", ");
    option.append(name, detail);
    option.addEventListener("click", () => loadLocation({ ...place, label: placeLabel(place) }));
    elements.locationResults.append(option);
  }
  elements.locationResults.hidden = false;
  elements.location.setAttribute("aria-expanded", "true");
}

function closePlaceChoices() {
  elements.locationResults.hidden = true;
  elements.location.setAttribute("aria-expanded", "false");
}

function averageRainfall(daily) {
  const totalsByYear = new Map();
  const monthTotals = Array.from({ length: 12 }, () => ({ total: 0, years: new Set() }));
  for (let i = 0; i < (daily.time || []).length; i += 1) {
    const mm = daily.rain_sum?.[i];
    if (mm == null || !Number.isFinite(Number(mm))) continue;
    const [yearText, monthText] = daily.time[i].split("-");
    const year = Number(yearText);
    const month = Number(monthText) - 1;
    totalsByYear.set(year, (totalsByYear.get(year) || 0) + Number(mm));
    monthTotals[month].total += Number(mm);
    monthTotals[month].years.add(year);
  }
  const years = [...totalsByYear.keys()];
  if (!years.length) throw new Error("No rainfall history was returned for this location.");
  const monthly = monthTotals.map((entry) => entry.years.size ? entry.total / entry.years.size : 0);
  const annual = years.reduce((sum, year) => sum + totalsByYear.get(year), 0) / years.length;
  return { monthly, annual, years: years.sort((a, b) => a - b) };
}

function getArchiveDates() {
  const now = new Date();
  const latestFullYear = now.getUTCFullYear() - 1;
  return {
    start: `${latestFullYear - 4}-01-01`,
    end: `${latestFullYear}-12-31`,
    label: `${latestFullYear - 4}–${latestFullYear}`,
  };
}

async function fetchRainData(place) {
  const { start, end, label } = getArchiveDates();
  const base = new URL("https://archive-api.open-meteo.com/v1/archive");
  base.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude), start_date: start, end_date: end, daily: "rain_sum", timezone: place.timezone || "auto" });
  const forecast = new URL("https://api.open-meteo.com/v1/forecast");
  forecast.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude), daily: "rain_sum", forecast_days: "7", timezone: place.timezone || "auto" });
  const [historyResponse, forecastResponse] = await Promise.all([fetch(base), fetch(forecast)]);
  if (!historyResponse.ok || !forecastResponse.ok) throw new Error("Weather data could not be loaded. Please try again.");
  const [history, forecastData] = await Promise.all([historyResponse.json(), forecastResponse.json()]);
  if (history.error) throw new Error(history.reason || "No rainfall data is available for this location.");
  if (forecastData.error) throw new Error(forecastData.reason || "The rainfall forecast is unavailable.");
  return { averages: averageRainfall(history.daily || {}), forecast: forecastData.daily || {}, period: label };
}

async function loadLocation(place) {
  closePlaceChoices();
  const chosen = { ...place, label: place.label || placeLabel(place) };
  state.location = chosen;
  state.monthlyRain = null;
  state.yearlyRain = null;
  state.forecast = null;
  elements.location.value = chosen.label;
  elements.selectedLocation.textContent = chosen.label;
  elements.resultsTitle.innerHTML = "Gathering your<br />rainfall data…";
  elements.annual.textContent = "—";
  elements.monthly.innerHTML = "— <small>L</small>";
  elements.forecastLitres.innerHTML = "— <small>L</small>";
  elements.chart.innerHTML = '<div class="chart-empty"><span class="chart-empty-drop">↗</span>Loading local rainfall history</div>';
  elements.forecastDays.innerHTML = '<div class="forecast-empty">Loading the local forecast…</div>';
  elements.save.disabled = true;
  setLoading(true);
  setStatus(`Loading rainfall history for ${chosen.label}…`);
  try {
    const data = await fetchRainData(chosen);
    if (state.location !== chosen) return;
    state.monthlyRain = data.averages.monthly;
    state.yearlyRain = data.averages.annual;
    state.forecast = data.forecast;
    elements.rainfallPeriod.textContent = data.period;
    elements.resultsTitle.innerHTML = "Your roof’s<br />rain potential.";
    renderEstimate();
    renderChart();
    renderStorage();
    renderForecast();
    elements.save.disabled = false;
    setBadge("Weather data ready");
    setStatus(`Rainfall history loaded for ${chosen.label}.`);
  } catch (error) {
    if (state.location !== chosen) return;
    elements.resultsTitle.innerHTML = "We couldn’t load<br />that rainfall data.";
    elements.annualSub.textContent = "Check your connection, then try again.";
    elements.chart.innerHTML = '<div class="chart-empty"><span class="chart-empty-drop">↻</span>Rainfall data is unavailable</div>';
    elements.forecastDays.innerHTML = '<div class="forecast-empty">Weather data is unavailable. Please try again.</div>';
    setBadge("Data unavailable", "error");
    setStatus(error.message || "Weather data could not be loaded. Please try again.", "error");
    renderStorage();
  } finally {
    if (state.location === chosen) setLoading(false);
  }
}

function getRoofArea() {
  return Math.max(0, Number(elements.roof.value) || 0);
}

function renderEstimate() {
  if (!state.location || !state.monthlyRain || state.yearlyRain == null) return;
  const area = getRoofArea();
  if (area < 1 || area > 1000000) {
    elements.annual.textContent = "—";
    elements.annualSub.textContent = "Enter a roof area from 1 to 1,000,000 m²";
    elements.monthly.innerHTML = "— <small>L</small>";
    elements.forecastLitres.innerHTML = "— <small>L</small>";
    elements.save.disabled = true;
    renderStorage();
    return;
  }
  elements.save.disabled = false;
  const annualLitres = area * state.yearlyRain * EFFICIENCY;
  const monthlyRainAverage = state.monthlyRain.reduce((sum, value) => sum + value, 0) / 12;
  const monthlyLitres = area * monthlyRainAverage * EFFICIENCY;
  const forecastRain = (state.forecast?.rain_sum || []).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const forecastLitres = area * forecastRain * EFFICIENCY;
  elements.annual.textContent = formatNumber(annualLitres);
  elements.annualSub.textContent = `${formatNumber(state.yearlyRain, 1)} mm average rain · ${formatNumber(area, 1)} m² roof · 80% efficiency`;
  elements.monthly.innerHTML = `${formatNumber(monthlyLitres)} <small>L</small>`;
  elements.monthlyRainfall.textContent = `${formatNumber(monthlyRainAverage, 1)} mm average rain / month`;
  elements.forecastLitres.innerHTML = `${formatNumber(forecastLitres)} <small>L</small>`;
  elements.forecastRainfall.textContent = `${formatNumber(forecastRain, 1)} mm forecast over 7 days`;
  elements.rainfallSummary.textContent = `Average rainfall by month · ${formatNumber(area, 1)} m² roof`;
  renderStorage();
}

function renderChart() {
  if (!state.monthlyRain) return;
  const values = state.chartMode === "yield" ? state.monthlyRain.map((rain) => rain * getRoofArea() * EFFICIENCY) : state.monthlyRain;
  const maxRain = Math.max(...values, 1);
  const peak = Math.max(...values);
  const peakIndex = values.indexOf(peak);
  const unit = state.chartMode === "yield" ? "litres" : "millimetres";
  elements.rainfallSummary.textContent = state.chartMode === "yield"
    ? `Estimated monthly yield · ${formatNumber(getRoofArea(), 1)} m² roof`
    : `Average rainfall by month · ${formatNumber(getRoofArea(), 1)} m² roof`;
  $(".chart-units").textContent = `${unit} per month`;
  elements.chart.replaceChildren();
  elements.chart.setAttribute("aria-label", `${state.chartMode === "yield" ? "Estimated collection" : "Average monthly rainfall"} for ${elements.selectedLocation.textContent}; peak is ${MONTHS[peakIndex]} at ${formatNumber(peak, 1)} ${unit}.`);
  values.forEach((amount, index) => {
    const column = document.createElement("div");
    column.className = `month-col${index === peakIndex ? " is-peak" : ""}`;
    column.title = state.chartMode === "yield"
      ? `${MONTHS[index]}: ${formatNumber(state.monthlyRain[index], 1)} mm rainfall, ${formatNumber(amount)} litres estimated`
      : `${MONTHS[index]}: ${formatNumber(amount, 1)} mm rainfall, ${formatNumber(amount * getRoofArea() * EFFICIENCY)} litres estimated`;
    const valueLabel = document.createElement("span");
    valueLabel.className = "month-value";
    valueLabel.textContent = formatNumber(amount);
    const track = document.createElement("div");
    track.className = "month-bar-track";
    const bar = document.createElement("div");
    bar.className = "month-bar";
    bar.style.height = `${Math.max(values[index] > 0 ? 3 : 0, (values[index] / maxRain) * 96)}%`;
    track.append(bar);
    const label = document.createElement("span");
    label.className = "month-name";
    label.textContent = MONTHS[index];
    column.append(valueLabel, track, label);
    elements.chart.append(column);
  });
}

function renderStorage() {
  if (!state.monthlyRain) {
    elements.capacityFill.style.width = "0%";
    elements.capacityPercent.textContent = "Choose a location";
    elements.peakMonth.textContent = "Peak month";
    elements.storageCallout.innerHTML = '<span class="storage-callout-icon">◌</span><span>Choose a location to see how your storage compares.</span>';
    return;
  }
  const peakRain = Math.max(...state.monthlyRain);
  const peakIndex = state.monthlyRain.indexOf(peakRain);
  const peakYield = peakRain * getRoofArea() * EFFICIENCY;
  const capacity = Math.max(0, Number(elements.storage.value) || 0);
  const percentOfPeak = peakYield > 0 ? Math.min(100, (capacity / peakYield) * 100) : 100;
  const storedPercent = peakYield > 0 ? Math.min(100, (peakYield / Math.max(capacity, 1)) * 100) : 0;
  const overflow = Math.max(0, peakYield - capacity);
  elements.capacityFill.style.width = `${percentOfPeak}%`;
  elements.capacityPercent.textContent = `${formatNumber(percentOfPeak)}% of peak month yield`;
  elements.peakMonth.textContent = `${MONTHS[peakIndex]} · ${formatNumber(peakYield)} L est.`;
  const detail = peakYield <= capacity
    ? `Your ${formatNumber(capacity)} L tank could hold a full average ${MONTHS[peakIndex]} yield (${formatNumber(peakYield)} L).`
    : `A wettest-month average could exceed your tank by about ${formatNumber(overflow)} L. A ${formatNumber(peakYield)} L capacity would hold that full yield.`;
  elements.storageCallout.innerHTML = `<span class="storage-callout-icon">◌</span><span>${detail}</span>`;
  elements.storageCallout.setAttribute("aria-label", `Storage fills about ${formatNumber(storedPercent)} percent from peak monthly collection.`);
}

function weatherSymbol(rain) {
  if (rain >= 10) return "☂";
  if (rain >= 1) return "☁";
  return "☼";
}

function renderForecast() {
  if (!state.forecast?.time) return;
  const times = state.forecast.time;
  const rains = state.forecast.rain_sum || [];
  const area = getRoofArea();
  elements.forecastDays.replaceChildren();
  times.forEach((date, index) => {
    const day = document.createElement("div");
    day.className = "forecast-day";
    const parsed = new Date(`${date}T12:00:00`);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(parsed);
    const rain = Number(rains[index]) || 0;
    day.innerHTML = `<span class="forecast-day-name">${index === 0 ? "Today" : weekday}</span><span class="forecast-weather-icon" aria-hidden="true">${weatherSymbol(rain)}</span><span class="forecast-day-rain">${formatNumber(rain, 1)} mm</span><span class="forecast-day-yield">${formatNumber(rain * area * EFFICIENCY)} L est.</span>`;
    day.setAttribute("aria-label", `${weekday}, ${formatNumber(rain, 1)} millimetres rain, ${formatNumber(rain * area * EFFICIENCY)} litres estimated collection`);
    elements.forecastDays.append(day);
  });
}

function readHistory() {
  try {
    const entries = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
    return true;
  } catch {
    elements.historyFeedback.textContent = "Browser storage is unavailable.";
    return false;
  }
}

function renderHistory() {
  const entries = readHistory();
  elements.historyList.replaceChildren();
  elements.clearHistory.hidden = entries.length === 0;
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.innerHTML = '<span class="history-empty-icon">↺</span><span>Your saved calculations will show up here.</span>';
    elements.historyList.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "history-item";
    const location = document.createElement("div");
    const place = document.createElement("div");
    place.className = "history-place";
    place.textContent = entry.location;
    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${formatNumber(entry.area)} m² roof · ${formatNumber(entry.monthly)} L / month average`;
    location.append(place, meta);
    const annual = document.createElement("div");
    annual.className = "history-annual";
    annual.textContent = `${formatNumber(entry.annual)} L / yr`;
    const date = document.createElement("div");
    date.className = "history-date";
    date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(entry.savedAt));
    const remove = document.createElement("button");
    remove.className = "history-delete";
    remove.type = "button";
    remove.title = "Delete saved estimate";
    remove.setAttribute("aria-label", `Delete estimate for ${entry.location}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      writeHistory(readHistory().filter((item) => item.id !== entry.id));
      renderHistory();
    });
    row.append(location, annual, date, remove);
    elements.historyList.append(row);
  }
}

function saveEstimate() {
  if (!state.location || state.yearlyRain == null) return;
  const area = getRoofArea();
  const monthRain = state.monthlyRain.reduce((sum, value) => sum + value, 0) / 12;
  const entry = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    location: state.location.label,
    area,
    annual: area * state.yearlyRain * EFFICIENCY,
    monthly: area * monthRain * EFFICIENCY,
    savedAt: new Date().toISOString(),
  };
  const next = [entry, ...readHistory()].slice(0, 20);
  if (writeHistory(next)) {
    elements.historyFeedback.textContent = "Saved to your calculation history.";
    renderHistory();
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = elements.location.value.trim();
  if (!query) {
    setStatus("Enter a city or postcode to find local rainfall.", "error");
    elements.location.focus();
    return;
  }
  if (getRoofArea() < 1 || getRoofArea() > 1000000) {
    setStatus("Enter a roof area from 1 to 1,000,000 m².", "error");
    elements.roof.focus();
    return;
  }
  setLoading(true);
  setStatus(`Searching for ${query}…`);
  try {
    const places = await searchPlaces(query);
    if (places.length === 1) {
      await loadLocation({ ...places[0], label: placeLabel(places[0]) });
    } else {
      setLoading(false);
      setBadge("Choose a location");
      setStatus(places.length ? "Choose the matching place to load its rainfall." : "No matching places found. Try a nearby city or postcode.", places.length ? "" : "error");
      renderPlaceChoices(places);
    }
  } catch (error) {
    setLoading(false);
    setBadge("Search unavailable", "error");
    setStatus(error.message || "Location search is unavailable right now.", "error");
  }
});

elements.location.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePlaceChoices();
});
document.addEventListener("click", (event) => {
  if (!elements.locationResults.contains(event.target) && event.target !== elements.location) closePlaceChoices();
});

elements.useLocation.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("Location access is not available in this browser.", "error");
    return;
  }
  setStatus("Waiting for location permission…");
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => loadLocation({ name: "Your current location", latitude: coords.latitude, longitude: coords.longitude, timezone: "auto", label: "Your current location", isCurrent: true }),
    (error) => setStatus(error.code === error.PERMISSION_DENIED ? "Location permission was declined. Search for a city instead." : "Could not read your location. Search for a city instead.", "error"),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
});

elements.roof.addEventListener("input", () => {
  if (getRoofArea() < 1 || getRoofArea() > 1000000) {
    elements.roof.setCustomValidity("Enter an area from 1 to 1,000,000 m².");
    setStatus("Enter a roof area from 1 to 1,000,000 m².", "error");
    elements.save.disabled = true;
  } else {
    elements.roof.setCustomValidity("");
    if (state.location) setStatus(`Estimate updated for ${state.location.label}.`);
  }
  renderEstimate();
  renderChart();
  renderForecast();
});
elements.storage.addEventListener("input", renderStorage);
document.querySelectorAll("[data-chart-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.chartMode = button.dataset.chartMode;
    document.querySelectorAll("[data-chart-mode]").forEach((toggle) => {
      const active = toggle === button;
      toggle.classList.toggle("unit-active", active);
      toggle.setAttribute("aria-pressed", String(active));
    });
    renderChart();
  });
});
elements.save.addEventListener("click", saveEstimate);
elements.clearHistory.addEventListener("click", () => {
  if (writeHistory([])) {
    elements.historyFeedback.textContent = "Calculation history cleared.";
    renderHistory();
  }
});

renderHistory();
