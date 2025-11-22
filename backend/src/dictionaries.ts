export const dictionaries = {
  regions: ['Southbank', 'Melbourne City', 'Docklands', 'St Kilda'],
  property_types: ['studio', '1b1b', '2b2b', 'townhouse'],
  bed_types: ['single', 'double', 'queen', 'king', 'sofa'],
  facilities: ['gym', 'pool', 'parking', 'elevator'],
  order_sources: ['airbnb', 'offline', 'other'],
  parking_types: ['none', 'street', 'garage', 'assigned', 'visitor'],
  access_types: ['keybox', 'smartlock', 'concierge'],
  floors: Array.from({ length: 60 }, (_, i) => String(i + 1)),
}