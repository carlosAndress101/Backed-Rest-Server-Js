const request = require("supertest");
const Server = require('../models/server');
const User = require('../models/user');


describe("test for app", () => {
  let app = null;
  let server = null;
  let api = null;

  beforeEach(()=> {

    app = new Server();
    server = app.listen(9000);
    api = request(app);

  })

  describe('GET / users', () => {
    //tests for users
    
  });

  describe('POST / users', () => {
    //tests for users
    test('should return a 400 Bad request', async () => {
        const inputData ={
            name:"carlos",
            email:"------",
            password:"123456789",
            role:"USER_ROLE",
        }

        const res = await api.post('/api/user/').send(inputData);
        expect(res.statusCode).tobe(400)

    });

    describe('GET /users/{id}', () => {
        test('should return a user', async () => {
          const user = await User.findById('1');
          const { statusCode, body } = await api.get(`/api/user/${user.id}`);
          expect(statusCode).toEqual(200);
          expect(body.id).toEqual(user.id);
        });
      });
  });

  describe('PUT / users', () => {
    //tests for users

  });
  

  afterEach(()=> {
    server.close();
  });
});
