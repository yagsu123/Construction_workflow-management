// e-MB capture: read the photo's ORIGINAL bytes, read GPS, post JSON.
//
// This used to re-encode the photo through a <canvas> to shrink it. That also stripped the
// EXIF block — which is exactly the evidence that proves where and when the photo was taken.
// A smaller upload was not worth surrendering the only thing that makes "geo-tagged" mean
// anything, so the original bytes now go up untouched.

const MAX_BYTES = 12 * 1024 * 1024;

/** The file's own bytes as a data URL — no re-encoding, so EXIF survives. */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Choose a site photo first'));
    if (!file.type.startsWith('image/')) return reject(new Error('That file is not an image'));
    if (file.size > MAX_BYTES) {
      return reject(new Error(`That photo is ${(file.size / 1048576).toFixed(1)} MB; the limit is 12 MB`));
    }
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read that image'));
    fr.readAsDataURL(file);
  });
}

export function getPosition({ timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no location API'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      err => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? 'Location permission denied — an e-MB entry cannot be recorded without coordinates'
          : 'Could not get a location fix. Try again near a window, or outdoors.')),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

export const osmLink = (lat, lng) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;

export const coords = (lat, lng) =>
  `${Number(lat).toFixed(5)}°, ${Number(lng).toFixed(5)}°`;
