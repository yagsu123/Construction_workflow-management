// e-MB capture: downscale the photo in the browser, read GPS, post JSON.
// Downscaling client-side keeps the server dependency-free (no multipart parser)
// and keeps a 6 MB phone photo from becoming a 6 MB request.

const MAX_EDGE = 1280;
const QUALITY = 0.8;

export function compressToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Choose a site photo first'));
    if (!file.type.startsWith('image/')) return reject(new Error('That file is not an image'));

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
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
