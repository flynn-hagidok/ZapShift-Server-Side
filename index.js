const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const app = express();
const port = process.env.PORT || 5000;
const crypto = require("crypto");

function generateTrackingId() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();

    return `TRK-${date}-${random}`;
};

app.use(express.json());
app.use(cors());

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zgye7fw.mongodb.net/?appName=Cluster0`);


async function connectToMongoDB() {
    try {
        await client.connect();
        const db = client.db("zapShift_db");
        const parcelsCollection = db.collection("parcels");
        const paymentCollection = db.collection("payments")

        app.get("/parcels", async (req, res) => {
            const query = {};
            const { email } = req.query;
            if (email) {
                query.senderEmail = email;
            }
            const options = { sort: { createdAt: -1 } }
            const result = await parcelsCollection.find(query, options).toArray();
            res.send(result);
        });

        app.get("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = {
                _id: new ObjectId(id)
            }
            const result = await parcelsCollection.findOne(query);
            res.send(result);
        })

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
            console.log(session);
            res.send({ url: session.url })
        });

        //check payment status
        app.patch("/payment-success", async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            // console.log("session retrieve", session);

            const transactionId = session.payment_intent;
            const trackingId = generateTrackingId();
            const query = {
                transactionId: transactionId
            };
            const paymentExist = await paymentCollection.findOne(query);

            if (paymentExist) {
                return res.send({
                    message: 'already exist',
                    transactionId: paymentExist.transactionId,
                    trackingId: paymentExist.trackingId
                })
            }

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = {
                    _id: new ObjectId(id)
                }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
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
                    res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: paymentResult
                    })
                }
            }

            res.send({ sucess: false })
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
});