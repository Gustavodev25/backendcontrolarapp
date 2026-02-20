// Mock Firebase Admin
const mockUpdate = jest.fn();
const mockSet = jest.fn();
const mockDocs = [];

jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: {
    cert: jest.fn()
  },
  firestore: () => ({
    collection: () => ({
      get: jest.fn(() => Promise.resolve({
        empty: mockDocs.length === 0,
        docs: mockDocs
      }))
    })
  })
}));

const checkSubscriptions = require('../jobs/checkSubscriptions');

describe('Subscription Job', () => {
  beforeEach(() => {
    mockDocs.length = 0;
    mockUpdate.mockClear();
    mockSet.mockClear();
    jest.restoreAllMocks();
  });

  test('should not deactivate active users based only on overdue date', async () => {
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 5);

    const mockDoc = {
      id: 'user_expired',
      data: () => ({
        subscription: {
          status: 'active',
          nextBillingDate: expiredDate.toISOString()
        }
      }),
      ref: {
        update: mockUpdate,
        set: mockSet
      }
    };
    mockDocs.push(mockDoc);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await checkSubscriptions();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no auto-cancel by date'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('should warn users expiring in 7 days', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    const mockDoc = {
      id: 'user_warning',
      data: () => ({
        subscription: {
          status: 'active',
          nextBillingDate: futureDate.toISOString()
        }
      }),
      ref: {
        update: mockUpdate
      }
    };
    mockDocs.push(mockDoc);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await checkSubscriptions();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Plan expires in 7 days'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
