export const SHOP = {
  phone: '617545837',
  phoneFmt: '617 54 58 37',
  mapLink: 'https://maps.google.com/?q=Carrer+Ateneu+Musical+63a+Cullera+Valencia',
  address: 'Carrer Ateneu Musical, 63a, 46400 Cullera, Valencia, España',
  services: [
    { name: 'Corte de pelo', price: 16 },
    { name: 'Corte + barba', price: 21 },
    { name: 'Arreglo de barba', price: 11 },
    { name: 'Corte + barba + afeitado con vapor + masaje capilar', price: 30 },
    { name: 'Degradado', price: 14 },
    { name: 'Afeitado + degradado + barba', price: 19 },
    { name: 'Corte + diseño / dibujo', price: 18 },
    { name: 'Mechas', price: 40 },
    { name: 'Color completo', price: 60 },
  ],
  hours: [
    { day: 'Lunes', time: 'Cerrado', open: false },
    { day: 'Martes', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Miércoles', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Jueves', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Viernes', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Sábado', time: '10:00–15:00', open: true },
    { day: 'Domingo', time: 'Cerrado', open: false },
  ],
};

export const BOOKING_TRIGGER = 'SHOW_BOOKING_FORM';

/** Frase que envía el usuario al reservar (accesos rápidos y normalización). */
export const BOOKING_USER_MESSAGE = 'Me gustaría reservar una cita';
