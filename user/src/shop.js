export const SHOP = {
  phone: '617545837',
  phoneFmt: '617 54 58 37',
  mapLink: 'https://maps.google.com/?q=Carrer+Ateneu+Musical+63a+Cullera+Valencia',
  address: 'Carrer Ateneu Musical, 63a, 46400 Cullera, Valencia, Spain',
  services: [
    { name: 'Haircut', price: 16 },
    { name: 'Haircut + Beard Trim', price: 21 },
    { name: 'Beard Grooming', price: 11 },
    { name: 'Haircut + Beard + Steam Shave + Head Massage', price: 30 },
    { name: 'Fade', price: 14 },
    { name: 'Shave + Fade + Beard', price: 19 },
    { name: 'Haircut + Design / Pattern', price: 18 },
    { name: 'Highlights', price: 40 },
    { name: 'Full Color', price: 60 },
  ],
  hours: [
    { day: 'Monday', time: 'Closed', open: false },
    { day: 'Tuesday', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Wednesday', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Thursday', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Friday', time: '10:00–13:30  /  15:30–20:00', open: true },
    { day: 'Saturday', time: '10:00–15:00', open: true },
    { day: 'Sunday', time: 'Closed', open: false },
  ],
};

export const BOOKING_TRIGGER = 'SHOW_BOOKING_FORM';
