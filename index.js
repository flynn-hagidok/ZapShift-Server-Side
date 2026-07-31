const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const app = express();
const port = process.env.PORT || 5000;
const crypto = require("crypto");
const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


function generateTrackingId() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();

    return `TRK-${date}-${random}`;
};

app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).send({ message: "unathorized access" });
    };

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        next();
    } catch (err) {
        res.status(401).send({ message: 'unauthorized access' });
    }
}

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zgye7fw.mongodb.net/?appName=Cluster0`);

async function connectToMongoDB() {
    try {
        await client.connect();
        const db = client.db("zapShift_db");
        const usersCollection = db.collection("users");
        const parcelsCollection = db.collection("parcels");
        const paymentCollection = db.collection("payments");
        const riderCollection = db.collection("riders");
        const trackingsCollection = db.collection("trackings");

        const verifyRider = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            if (!user || user.role !== 'rider') {
                return res.status(403).send({ message: "forbidden access" });
            }
            next();
        };

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: "forbidden access" });
            }
            next();
        };

        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split("-").join(" "),
                createdAt: new Date()
            }

            const result = await trackingsCollection.insertOne(log);
            return result;
        };

        app.get("/users", verifyFBToken, async (req, res) => {
            const search = req.query.search;
            const query = {};

            if (search) {
                // query.displayName = search
                // query.displayName = { $regex: search, $options: "i" }
                query.$or = [
                    { displayName: { $regex: search, $options: 'i' } },
                    { email: { $regex: search, $options: 'i' } }
                ]
            };

            const result = await usersCollection.find(query).sort({ createdAt: -1 }).limit(5).toArray();
            res.send(result);
        });

        app.get("/users/:id", async (req, res) => {

        });

        app.get("/users/:email/role", verifyFBToken, async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ role: user?.role || 'user' });
        });

        app.post("/users", async (req, res) => {
            const user = req.body;
            const email = user.email;
            const exitingUser = await usersCollection.findOne({ email });

            if (exitingUser) {
                return res.send({ message: 'user already exist' });
            }

            user.role = "user";
            user.createdAt = new Date();
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });

        app.patch("/users/:id/role", verifyFBToken, verifyAdmin, async (req, res) => {
            console.log("PATCH route reached");
            const id = req.params.id;
            const userInfo = req.body;
            const query = {
                _id: new ObjectId(id)
            };
            const updataInfo = {
                $set: {
                    role: userInfo.role
                }
            }
            const result = await usersCollection.updateOne(query, updataInfo);
            res.send(result);
        });

        app.get("/parcels", async (req, res) => {
            const query = {};
            const { email, deliveryStatus } = req.query;
            if (email) {
                query.senderEmail = email;
            };
            if (deliveryStatus) {
                query.delivery = deliveryStatus;
            }
            const options = { sort: { createdAt: -1 } }
            const result = await parcelsCollection.find(query, options).toArray();
            res.send(result);
        });

        app.get("/parcels/rider", async (req, res) => {
            const { riderEmail, delivery } = req.query;
            const query = {};
            if (riderEmail) {
                query.riderEmail = riderEmail;
            }
            if (delivery !== "parcel_delivered") {
                // query.delivery = { $in: ['pickup', 'rider_arrived'] }
                query.delivery = { $nin: ['parcel_delivered'] }
            }
            else {
                query.delivery = delivery
            }

            const result = await parcelsCollection.find(query).toArray();
            res.send(result);
        });

        app.get("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = {
                _id: new ObjectId(id)
            }
            const result = await parcelsCollection.findOne(query);
            res.send(result);
        });

        app.get("/parcels/delivery-status/stats", async (req, res) => {
            const pipeline = [
                {
                    $group: {
                        _id: '$delivery',
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        status: '$_id',
                        count: 1,
                        // _id: 0
                    }
                }
            ]
            const result = await parcelsCollection.aggregate(pipeline).toArray();
            res.send(result);
        });

        app.post("/parcels", async (req, res) => {
            const parcels = req.body;
            //parcels created time
            parcels.createdAt = new Date();
            const result = await parcelsCollection.insertOne(parcels);
            res.send(result);
        });

        app.delete("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = {
                _id: new ObjectId(id)
            }
            const result = await parcelsCollection.deleteOne(query);
            res.send(result);
        });

        app.patch("/parcels/:id", async (req, res) => {
            const { riderId, riderEmail, riderName, riderPhone, trackingId } = req.body;
            const id = req.params.id;
            const query = {
                _id: new ObjectId(id)
            };
            const updateDoc = {
                $set: {
                    delivery: 'pickup',
                    riderId: riderId,
                    riderEmail: riderEmail,
                    riderName: riderName,
                    riderPhone: riderPhone,
                }
            };
            const result = await parcelsCollection.updateOne(query, updateDoc);

            const riderQuery = {
                _id: new ObjectId(riderId)
            };
            const updateRiderDocs = {
                $set: {
                    workStatus: 'in-delivery'
                }
            };
            const riderResult = await riderCollection.updateOne(riderQuery, updateRiderDocs);
            logTracking(trackingId, 'pickup')
            res.send(riderResult)

        });

        app.patch("/parcels/:id/status", async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body;
            const id = req.params.id;
            const query = {
                _id: new ObjectId(id)
            };
            const updateStatus = {
                $set: {
                    delivery: deliveryStatus
                }
            };

            if (deliveryStatus === "parcel_delivered") {
                const riderQuery = {
                    _id: new ObjectId(riderId)
                };
                const updateStatus = {
                    $set: {
                        workStatus: "available"
                    }
                }
                const riderResult = await riderCollection.updateOne(riderQuery, updateStatus);
                res.send(riderResult);
            }
            const result = await parcelsCollection.updateOne(query, updateStatus);
            logTracking(trackingId, deliveryStatus)
            res.send(result);
        });


        //stripe payment api 
        app.post("/payment-checkout-session", async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: "usd",
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName
                            }
                        },
                        quantity: 1
                    }
                ],
                mode: "payment",
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName
                },
                customer_email: paymentInfo.senderEmail,
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-successful?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`
            })
            res.send({ url: session.url });
        });

        //old
        app.post("/create-checkout-session", async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        // Provide the exact Price ID (for example, price_1234) of the product you want to sell
                        price_data: {
                            currency: "USD",
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName
                            }
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-successful`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            })
            res.send({ url: session.url })
        });

        //check payment status
        app.patch("/payment-success", async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            const transactionId = session.payment_intent;
            const query = {
                transactionId: transactionId,
            };
            const paymentExist = await paymentCollection.findOne(query);

            if (paymentExist) {
                return res.send({
                    message: 'already exist',
                    transactionId: paymentExist.transactionId,
                    trackingId: paymentExist.trackingId
                })
            }

            const trackingId = generateTrackingId();

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = {
                    _id: new ObjectId(id)
                }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        delivery: 'pending-pickup',
                        trackingId: trackingId
                    }
                }

                const result = await parcelsCollection.updateOne(query, update);

                const payment = {
                    amount: session.amount_total,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }

                if (session.payment_status === 'paid') {
                    const paymentResult = await paymentCollection.insertOne(payment);

                    logTracking(trackingId, 'pending-pickup')

                    return res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: paymentResult
                    })
                }
            }

            return res.send({ sucess: false })
        })

        //payments related apis
        app.get("/payments", verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};
            if (email) {
                query.customerEmail = email;
                if (email !== req.decoded_email) {
                    res.status(403).send({ message: 'forbidden access' });
                }
            };
            const result = await paymentCollection.find(query).sort({ paidAt: -1 }).toArray();
            res.send(result);
        })

        //riders related api
        app.post("/riders", async (req, res) => {
            const rider = req.body;
            rider.status = "pending";
            rider.createAt = new Date();
            const result = await riderCollection.insertOne(rider);
            res.send(result);
        });

        app.get("/riders", async (req, res) => {
            const { status, district, workStatus } = req.query;
            const query = {};
            if (status) {
                query.status = status;
            };
            if (district) {
                query.riderDistrict = district;
            };
            if (workStatus) {
                query.workStatus = workStatus;
            };
            const result = await riderCollection.find(query).toArray();
            res.send(result);
        });

        app.get("/riders/delivery-per-day", async (req, res) => {
            const email = req.query.email;
            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        delivery: 'parcel_delivered'
                    }
                },
                {
                    $lookup: {
                        from: "trackings",
                        localField: "trackingId",
                        foreignField: "trackingId",
                        as: "parcel_trackings"
                    }
                },
                {
                    $unwind: "$parcel_trackings"
                },
                {
                    $match: {
                        "parcel_trackings.status": 'parcel_delivered'
                    }
                },
                {
                    $addFields: {
                        deliveryDay: {
                            $dateToString: {
                                format: "%d-%m-%Y",
                                date: "$parcel_trackings.createdAt"
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: "$deliveryDay",
                        deliveredCount: { $sum: 1 }
                    }
                }
            ]
            const result = await parcelsCollection.aggregate(pipeline).toArray();
            res.send(result);
        })

        app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
            const status = req.body.status;
            console.log(req.body);
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            };
            const result = await riderCollection.updateOne(query, updateDoc);

            if (status === 'approved') {
                const email = req.body.email;
                const query = { email };
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                };
                const result = await usersCollection.updateOne(query, updateUser);
            };

            res.send(result);
        })

        //tracking related apis 
        app.get("/tracking/:trackingId/logs", async (req, res) => {
            const { trackingId } = req.params;
            const query = {
                trackingId
            };
            const result = await trackingsCollection.find(query).toArray();
            res.send(result);
        })

    } catch (err) {
        console.dir(err);
    }
}

connectToMongoDB();

app.get("/", (req, res) => {
    res.send("zapshift server is running");
});

app.listen(port, (req, res) => {
    console.log(`server is running in port`, port);
});;